import type { Env } from "./types";
import { rooftopFor } from "./rooftops";
import { cleanReply } from "./drafter";
import { SAFETY_RULES } from "./guidelines";

// Reads replies your team wrote and has Claude turn them into drafting
// guidelines. The result is a draft for an admin to review, never saved
// automatically. The agent's own replies are excluded so it doesn't learn
// from itself.

const PER_RATING = 30;           // replies sampled per star rating
const MAX_PASTED_CHARS = 150_000;
export const MIN_REPLIES = 20;

const LEARN_PROMPT = `You write the reply guidelines that a drafting assistant follows when it writes
public owner replies to Google reviews for Lester Glenn Auto Group, a family-owned
New Jersey dealership group serving customers since 1956.

You'll receive real replies the team has written. Study them closely: tone and warmth,
how replies open and close, typical length at each star rating, how complaints are
handled, how people are invited to continue offline (which roles are named), sign-off
style, phrases the team uses often, and anything they consistently avoid. Capture what
the best replies do well and leave out habits that read as canned or careless.

Write the guidelines in Markdown with these sections:
## Voice
## Length
## Positive reviews
## Mixed or negative reviews
## Store-specific notes (only if the replies show real, consistent differences between stores; otherwise omit)
## Phrases we use and phrases to avoid
## Example replies

For Example replies, write 6 to 8 short examples adapted from the strongest real replies,
covering a 5-star review, a rating with no text, a 4-star review with a small complaint,
a 3-star review, and 1 or 2 star reviews. Label each with the star rating and department.
Anonymize them: remove every customer name, and replace employee names with [team member].
End each example with a sign-off line in the form "The Lester Glenn [Store] Team".

Rules for what you write:
- The drafting assistant is given the reviewer's first name when Google provides one. If the team greets reviewers by first name, say so; never use last names.
- Where the team's habits conflict with the non-negotiable rules below, follow the rules
  and don't describe the conflicting habit.
- Don't invent policies, phone numbers, staff names, hours, or promotions.
- Never use em-dashes.
- Output only the guidelines, starting with the first heading. No preamble.

${SAFETY_RULES}`;

export interface LearnResult { draft?: string; used?: number; error?: string }

/** How many human-written Google replies are available to learn from. */
export async function availableReplies(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM reviews WHERE is_sample = 0 AND reply_source IN ('google','manager') AND length(reply_text) > 20`
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function sampleFromGoogle(env: Env): Promise<{ text: string; used: number }> {
  const q = env.DB.prepare(
    `SELECT rooftop_key, location_title, stars, text, reply_text FROM reviews
     WHERE is_sample = 0 AND reply_source IN ('google','manager') AND length(reply_text) > 20 AND stars = ?
     ORDER BY reply_time DESC LIMIT ?`
  );
  const batches = await env.DB.batch([1, 2, 3, 4, 5].map((n) => q.bind(n, PER_RATING)));
  const rows = batches.flatMap((b) => b.results as any[]);
  const text = rows.map((r) => JSON.stringify({
    store: rooftopFor(r.rooftop_key, r.location_title).name,
    stars: r.stars,
    review: (r.text || "(rating only)").slice(0, 400),
    reply: r.reply_text,
  })).join("\n");
  return { text, used: rows.length };
}

export async function learnGuidelines(env: Env, source: "google" | "pasted", pasted = ""): Promise<LearnResult> {
  if (!env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY is not set." };

  let material: string;
  let used: number;
  if (source === "google") {
    const s = await sampleFromGoogle(env);
    if (s.used < MIN_REPLIES) {
      return { error: `Only ${s.used} replies written by your team are on file so far. At least ${MIN_REPLIES} are needed; paste replies instead, or try again after more reviews sync.` };
    }
    material = "Real replies, one JSON object per line:\n" + s.text;
    used = s.used;
  } else {
    const t = pasted.trim();
    if (t.length < 300) return { error: "Paste more replies first. A dozen or more gives much better results." };
    if (t.length > MAX_PASTED_CHARS) return { error: "That's more text than can be read at once. Paste fewer replies (around 150 is plenty)." };
    material = "Real replies pasted by the team (review text may or may not be included):\n\n" + t;
    used = 0;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 4000,
      system: LEARN_PROMPT,
      messages: [{ role: "user", content: material }],
    }),
  });
  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    return { error: `Claude API error ${res.status}: ${String(err?.error?.message || "no details").slice(0, 200)}` };
  }
  const data: any = await res.json();
  const raw = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  // Keep paragraph breaks; just enforce the no em-dash rule line by line
  const draft = raw.split("\n").map((line: string) => (line.trim() ? cleanReply(line).replace(/^(\s*)/, line.match(/^\s*/)![0]) : "")).join("\n").trim();
  if (!draft.startsWith("#")) return { error: "Claude's response didn't look like guidelines. Try again." };
  return { draft, used };
}

/* ---------- Learning from approvers' edits ---------- */

const EDITS_PROMPT = `You maintain the reply guidelines that a drafting assistant follows when writing
public owner replies to Google reviews for Lester Glenn Auto Group.

You'll receive the current guidelines and a set of drafts the assistant wrote next to the
final versions the managers actually approved. Find the consistent patterns in how the
managers change the drafts (things they always remove, add, shorten, soften, or reword),
and ignore one-off edits that only fix a fact about a single review.

Respond with ONLY a JSON object, no preamble:
{"summary": ["one short sentence per pattern you found, most common first"],
 "guidelines": "the full updated guidelines in Markdown, starting with the first heading"}

Rules for the updated guidelines:
- Keep the existing structure and anything the edits don't contradict.
- Change only what the edits show the managers want done differently.
- Never use em-dashes.
- Don't invent policies, phone numbers, staff names, or promotions.

${SAFETY_RULES}`;

export async function editStats(env: Env, since?: string | null): Promise<{ total: number; since: number }> {
  try {
    const row = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(created_at > ?) AS since FROM draft_edits").bind(since || "").first<{ total: number; since: number }>();
    return { total: row?.total || 0, since: row?.since || 0 };
  } catch { return { total: 0, since: 0 }; }
}

export async function suggestFromEdits(env: Env, currentGuidelines: string): Promise<{ draft?: string; summary?: string[]; used?: number; error?: string }> {
  if (!env.ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY is not set." };
  let rows: { stars: number; original: string; final: string }[] = [];
  try { rows = (await env.DB.prepare("SELECT stars, original, final FROM draft_edits ORDER BY id DESC LIMIT 60").all<any>()).results; }
  catch { return { error: "One-time setup needed: run migrations/0010_insights.sql in the D1 console." }; }
  if (rows.length < 5) return { error: `Only ${rows.length} edited replies are on file so far. Approve a few more edited drafts (at least 5) and try again.` };
  const material = `CURRENT GUIDELINES:\n${currentGuidelines}\n\nEDITS (draft, then the approved version), one JSON object per line:\n` +
    rows.map((r) => JSON.stringify({ stars: r.stars, draft: r.original, approved: r.final })).join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.CLAUDE_MODEL || "claude-sonnet-5", max_tokens: 6000, system: EDITS_PROMPT, messages: [{ role: "user", content: material }] }),
  });
  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    return { error: `Claude API error ${res.status}: ${String(err?.error?.message || "no details").slice(0, 200)}` };
  }
  try {
    const data: any = await res.json();
    const raw = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").replace(/^```(?:json)?|```$/gm, "").trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const draft = String(parsed.guidelines || "").replace(/\s*\u2014\s*/g, ", ").trim();
    if (!draft.startsWith("#")) return { error: "Claude's response didn't look like guidelines. Try again." };
    const summary = (parsed.summary || []).map((x: any) => String(x).replace(/\s*\u2014\s*/g, ", ")).slice(0, 10);
    return { draft, summary, used: rows.length };
  } catch { return { error: "Couldn't read Claude's response. Try again." }; }
}
