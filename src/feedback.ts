import type { Env } from "./types";
import { nowIso } from "./types";

// Thumbs up and down on drafts. Liked drafts become style examples for future drafts with a
// similar star rating; thumbs-down notes become short, general lessons that every future
// draft follows. Lessons live in the settings table and can be removed in Settings.

export interface Lesson { text: string; by: string; at: string; review_id?: string }

let cache: { lessons: Lesson[]; at: number } | null = null;

export async function getLessons(env: Env, fresh = false): Promise<Lesson[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.lessons;
  let lessons: Lesson[] = [];
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'guideline_lessons'").first<{ value: string }>();
    lessons = row ? JSON.parse(row.value) : [];
  } catch { /* settings table missing */ }
  cache = { lessons, at: Date.now() };
  return lessons;
}

export async function saveLessons(env: Env, lessons: Lesson[], by: string) {
  await env.DB.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('guideline_lessons', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(JSON.stringify(lessons.slice(-60)), by, nowIso()).run();
  cache = null;
}

/** Extra drafting instructions: lessons from feedback, plus a few liked replies for similar ratings. */
export async function feedbackPrompt(env: Env, stars: number): Promise<string> {
  const lessons = await getLessons(env);
  let examples: string[] = [];
  try {
    const [lo, hi] = stars >= 4 ? [4, 5] : stars === 3 ? [3, 3] : [0, 2];
    examples = (await env.DB.prepare(`SELECT draft FROM draft_feedback WHERE rating = 'up' AND draft IS NOT NULL AND stars BETWEEN ? AND ? ORDER BY id DESC LIMIT 3`)
      .bind(lo, hi).all<{ draft: string }>()).results.map((r) => r.draft);
  } catch { /* migration 0011 not run */ }
  let out = "";
  if (lessons.length) {
    out += `\n\n## Lessons from feedback (the managers asked for these; follow them)\n${lessons.map((l) => `- ${l.text}`).join("\n")}`;
  }
  if (examples.length) {
    out += `\n\n## Replies the managers liked (match the tone and length; never reuse their names or details)\n${examples.map((e, i) => `Example ${i + 1}:\n${e}`).join("\n\n")}`;
  }
  return out;
}

const LESSON_PROMPT = `A manager gave a thumbs down to a drafted reply to a Google review and explained why.
Turn their note into ONE short, general rule for writing future replies, if it applies beyond
this one review. For example "too long" becomes "Keep replies to 1-star reviews to three sentences."
and "don't say sorry twice" becomes "Apologize once, not repeatedly."
If the note only concerns this specific review (a fact, a name, an offer, a detail to add), there
is no general rule: return null.
Never include customer names, employee names, or details of this review in the rule. Never use em-dashes.
Respond with ONLY JSON: {"lesson": "the rule as one sentence"} or {"lesson": null}`;

export async function lessonFromNote(env: Env, stars: number, review: string, draft: string, note: string): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env.CLAUDE_MODEL || "claude-sonnet-5", max_tokens: 300, system: LESSON_PROMPT,
        messages: [{ role: "user", content: JSON.stringify({ stars, review: review || "(rating only)", draft, manager_note: note }) }] }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const raw = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const lesson = parsed.lesson ? String(parsed.lesson).replace(/\s*\u2014\s*/g, ", ").trim().slice(0, 240) : null;
    return lesson || null;
  } catch { return null; }
}
