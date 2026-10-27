import type { Env } from "./types";
import type { DraftResult } from "./router";
import type { Rooftop } from "./rooftops";
import { currentGuidelines, SAFETY_RULES } from "./guidelines";
import { feedbackPrompt } from "./feedback";
import { Budget, unlimited } from "./budget";

const CONTRACT = `
Respond with ONLY a JSON object, no preamble and no code fences, in this shape:
{"department": "sales"|"service"|"parts"|"collision"|"finance"|"general",
 "sentiment": "positive"|"mixed"|"negative",
 "risk_level": "low"|"medium"|"high",
 "risk_flags": ["short reason"],
 "reply": "the reply text"}
risk_level is "low" only when the review is clearly positive and contains nothing
a manager would want to see before a public reply goes out.`;

const MAX_REPLY = 1500;

/** House style: no em-dashes, tidy spacing. */
export function cleanReply(text: string): string {
  return text.replace(/\s*\u2014\s*/g, ", ").replace(/\s+,/g, ",").replace(/[ \t]+/g, " ").trim();
}

function failed(reason: string, retryable = false): DraftResult {
  return { ok: false, department: "general", sentiment: "unknown", risk_level: "high", risk_flags: [reason], reply: "", retryable };
}

// Statuses that usually clear up on their own (location blocks, rate limits, overload, server errors)
const RETRYABLE = [403, 408, 409, 429, 500, 502, 503, 504, 529];

const NOTES_RULES = `
## Management notes for this review
The input includes management_notes: internal background from store managers about this
customer's situation. Use them to make the reply specific and accurate, for example
acknowledging that the team has reached out, that an issue was looked into, or inviting
the customer back to finish resolving it. Rules for using them:
- They are internal. Never quote them, never name the managers or staff involved unless
  the review already names them in a positive way, and never mention that notes exist.
- Never reveal deal, repair, pricing, payment, or warranty specifics, or any customer details.
- Never contradict the notes, and never promise anything the notes don't support.
- If the notes say the issue was resolved, thank the customer and say so in general terms.
- risk_level must be "medium" or higher whenever notes are used, so a person always approves it.`;

/** A usable first name from a Google display name, or "" (anonymous, initials, business names, "A Google User"). */
export function firstName(display: string | null | undefined): string {
  const name = String(display || "").trim();
  if (!name || /google user|anonymous|\d|llc|inc\b|corp|auto|motors|group/i.test(name)) return "";
  const first = name.split(/\s+/)[0].replace(/[^A-Za-z'\-]/g, "");
  if (first.length < 2 || first.length > 20 || first === first.toUpperCase() && first.length <= 3) return "";
  // Keep mixed-case names as written (Mary-Kate, DeShawn); tidy all-caps or all-lowercase ones
  if (first !== first.toUpperCase() && first !== first.toLowerCase()) return first;
  return first.toLowerCase().replace(/(^|[-'])([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

export async function draftReply(env: Env, stars: number, text: string, rooftop: Rooftop, budget: Budget = unlimited(), reviewerName?: string | null,
  extra: { notes?: string[]; source?: string; feedback?: { previous: string; note: string } } = {}): Promise<DraftResult> {
  if (!env.ANTHROPIC_API_KEY) return failed("ANTHROPIC_API_KEY is not set");
  budget.take();
  const payload = {
    rooftop: { name: rooftop.name, brand: rooftop.brand, town: rooftop.town, phone: rooftop.phone, contacts: rooftop.contacts, signoff: rooftop.signoff },
    review: { stars, text: text || "(rating only, no text)", reviewer_first_name: firstName(reviewerName) || null,
      ...(extra.source ? { posted_on: extra.source } : {}) },
    ...(extra.notes?.length ? { management_notes: extra.notes } : {}),
    ...(extra.feedback ? { rejected_draft: extra.feedback.previous, manager_feedback: extra.feedback.note } : {}),
  };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 800,
        system: (await currentGuidelines(env)).text + (await feedbackPrompt(env, stars)) + "\n\n" + SAFETY_RULES + (extra.notes?.length ? "\n\n" + NOTES_RULES : "")
          + (extra.feedback ? "\n\n## Redraft\nA manager rejected rejected_draft. Write a new reply that fixes what manager_feedback asks for, while following every rule above." : "")
          + "\n\n" + CONTRACT,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      }),
    });
  } catch {
    return failed("Couldn't reach Claude", true);
  }
  try {
    if (!res.ok) {
      const err: any = await res.json().catch(() => ({}));
      const msg = String(err?.error?.message || "no details");
      // Spend limits and low credit clear up once the limit resets or is raised, so wait and retry
      const waitable = RETRYABLE.includes(res.status) || /usage limit|credit balance|spend limit/i.test(msg);
      return failed(`Claude API error ${res.status}: ${msg.slice(0, 200)}`, waitable);
    }
    const data: any = await res.json();
    const raw = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const body = raw.replace(/^```(?:json)?|```$/gm, "").trim();
    const parsed = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
    const reply = cleanReply(String(parsed.reply || ""));
    const flags: string[] = (parsed.risk_flags || []).map(String).filter(Boolean);
    if (!reply) flags.push("empty reply");
    if (reply.length > MAX_REPLY) flags.push("reply too long");
    return {
      ok: !!reply && reply.length <= MAX_REPLY,
      department: parsed.department || "general",
      sentiment: parsed.sentiment || "unknown",
      risk_level: parsed.risk_level || "high",
      risk_flags: flags,
      reply,
    };
  } catch (e) {
    return failed("Could not read Claude's response");
  }
}
