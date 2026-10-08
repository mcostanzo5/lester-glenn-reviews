import type { Env, User } from "./types";
import { mode, nowIso } from "./types";
import { Budget, BudgetExhausted } from "./budget";

// Finds employees named in reviews and ties them to each store's staff roster,
// so reviews can be tallied per person by calendar month.
//
// Matching rules (per store):
//  - exact full name or nickname match wins
//  - otherwise first name (or nickname) must match, plus last name or last initial if the review gives one
//  - if several people still match, the review's sales/service hint is used to pick one
//  - still more than one: "ambiguous", someone tags it by hand
//  - nobody on the roster: "unmatched", shows under Needs tagging until the person is added
// Manual tags ("manual") and "not an employee" ("ignored") are never overwritten.

export type StaffRole = "sales" | "service" | "other";
export interface Staff { id: number; rooftop_key: string; full_name: string; role: StaffRole; aliases: string; active: number }
interface Found { name: string; role: string; sentiment: string }

const BATCH = 25;          // reviews per Claude call
const MAX_TEXT = 1500;     // characters of each review sent

export const canTag = (u: User) => u.role === "admin" || u.canReply;

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z' -]/g, " ").replace(/\s+/g, " ").trim();

/** Roster members a name from a review could refer to. */
export function candidates(raw: string, roleHint: string, roster: Staff[]): Staff[] {
  const n = norm(raw);
  if (!n) return [];
  const parts = n.split(" ");
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const active = roster.filter((s) => s.active);
  const aliasesOf = (s: Staff) => s.aliases.split(",").map(norm).filter(Boolean);

  const exact = active.filter((s) => norm(s.full_name) === n || aliasesOf(s).includes(n));
  let match = exact.length ? exact : active.filter((s) => {
    const sp = norm(s.full_name).split(" ");
    const sf = sp[0], sl = sp.length > 1 ? sp[sp.length - 1] : "";
    if (!(sf === first || aliasesOf(s).includes(first))) return false;
    if (!last) return true;
    return sl === last || (last.length <= 2 && sl.startsWith(last));
  });
  if (match.length > 1 && ["sales", "service", "other"].includes(roleHint)) {
    const byRole = match.filter((s) => s.role === roleHint);
    if (byRole.length === 1) match = byRole;
  }
  return match;
}

function decide(raw: string, roleHint: string, roster: Staff[]): { staff_id: number | null; match: string } {
  const c = candidates(raw, roleHint, roster);
  if (c.length === 1) return { staff_id: c[0].id, match: "auto" };
  return { staff_id: null, match: c.length > 1 ? "ambiguous" : "unmatched" };
}

async function rosterFor(env: Env, rooftop: string): Promise<Staff[]> {
  return (await env.DB.prepare("SELECT * FROM staff WHERE rooftop_key = ?").bind(rooftop).all<Staff>()).results;
}

const EXTRACT_PROMPT = `You read Google reviews of car dealerships and list the dealership employees each review mentions by name.

Include anyone who works at the dealership: salespeople, sales and finance managers, service advisors, technicians, service managers, parts staff, receptionists, porters, detailers.
Exclude the reviewer, their family or friends, other customers, people at other businesses, brand or vehicle names, and words that only look like names.

Keep each name exactly as written, for example "Mike", "Mike S.", or "Michael Smith". List each person once per review.
role: "sales" for sales or finance, "service" for service advisors, technicians, service or parts staff, "other" for anyone else, "unknown" if the review doesn't say.
sentiment: how the review talks about that person: "positive", "negative", or "neutral".

Respond with ONLY JSON, no preamble:
{"results":[{"i":0,"mentions":[{"name":"Mike","role":"sales","sentiment":"positive"}]}]}
Include one entry for every review i you were given, with "mentions": [] when no employee is named.`;

async function extract(env: Env, items: { i: number; text: string }[], budget: Budget): Promise<Map<number, Found[]>> {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
  budget.take();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 4000,
      system: EXTRACT_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(items) }],
    }),
  });
  if (!res.ok) {
    const err: any = await res.json().catch(() => ({}));
    throw new Error(`Claude API error ${res.status}: ${String(err?.error?.message || "no details").slice(0, 200)}`);
  }
  const data: any = await res.json();
  const raw = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const body = raw.replace(/^```(?:json)?|```$/gm, "").trim();
  const parsed = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1));
  const out = new Map<number, Found[]>();
  for (const r of parsed.results || []) {
    const seen = new Set<string>();
    out.set(Number(r.i), (r.mentions || [])
      .map((m: any) => ({ name: String(m.name || "").trim().slice(0, 60), role: String(m.role || "unknown"), sentiment: String(m.sentiment || "neutral") }))
      .filter((m: Found) => norm(m.name) && !seen.has(norm(m.name)) && seen.add(norm(m.name))));
  }
  return out;
}

/** Reads unscanned reviews (newest first) and records who they mention. */
export async function scanReviews(env: Env, budget: Budget, opts: { from?: string; to?: string; rooftops?: string[] | "*"; maxBatches: number }) {
  const where = ["mentions_scanned_at IS NULL"];
  const args: unknown[] = [];
  if (mode(env) !== "dry_run") where.push("is_sample = 0");
  if (opts.from) { where.push("create_time >= ?"); args.push(opts.from); }
  if (opts.to) { where.push("create_time < ?"); args.push(opts.to); }
  if (opts.rooftops && opts.rooftops !== "*") { where.push(`rooftop_key IN (${opts.rooftops.map(() => "?").join(",") || "''"})`); args.push(...opts.rooftops); }
  const sql = `SELECT id, rooftop_key, create_time, stars, text FROM reviews WHERE ${where.join(" AND ")}`;
  let scanned = 0, found = 0;
  const rosters = new Map<string, Staff[]>();

  for (let b = 0; b < opts.maxBatches; b++) {
    const rows = (await env.DB.prepare(`${sql} ORDER BY create_time DESC LIMIT ?`).bind(...args, BATCH).all<any>()).results;
    if (!rows.length) break;
    const withText = rows.filter((r) => (r.text || "").trim());
    let results = new Map<number, Found[]>();
    if (withText.length) {
      if (!budget.has(1)) break;
      results = await extract(env, withText.map((r, i) => ({ i, text: String(r.text).slice(0, MAX_TEXT) })), budget);
    }
    const writes: D1PreparedStatement[] = [];
    for (const r of rows) {
      const i = withText.indexOf(r);
      const mentions = i >= 0 ? results.get(i) || [] : [];
      if (!rosters.has(r.rooftop_key)) rosters.set(r.rooftop_key, await rosterFor(env, r.rooftop_key));
      const kept = (await env.DB.prepare("SELECT name_raw FROM mentions WHERE review_id = ? AND match IN ('manual','ignored')").bind(r.id).all<{ name_raw: string }>())
        .results.map((m) => norm(m.name_raw));
      writes.push(env.DB.prepare("DELETE FROM mentions WHERE review_id = ? AND match IN ('auto','ambiguous','unmatched')").bind(r.id));
      for (const m of mentions) {
        if (kept.includes(norm(m.name))) continue;
        const d = decide(m.name, m.role, rosters.get(r.rooftop_key)!);
        writes.push(env.DB.prepare(`INSERT INTO mentions (review_id, rooftop_key, review_time, stars, name_raw, role_hint, sentiment, staff_id, match)
          VALUES (?,?,?,?,?,?,?,?,?)`).bind(r.id, r.rooftop_key, r.create_time, r.stars, m.name, m.role, m.sentiment, d.staff_id, d.match));
        found++;
      }
      writes.push(env.DB.prepare("UPDATE reviews SET mentions_scanned_at = ? WHERE id = ?").bind(nowIso(), r.id));
      scanned++;
    }
    await env.DB.batch(writes);
  }
  const remaining = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE ${where.join(" AND ")}`).bind(...args).first<{ n: number }>())?.n ?? 0;
  return { scanned, found, remaining };
}

/** Re-run matching for a store after its roster changes. Manual tags are left alone. */
export async function rematch(env: Env, rooftop: string) {
  const roster = await rosterFor(env, rooftop);
  const rows = (await env.DB.prepare("SELECT id, name_raw, role_hint, staff_id, match FROM mentions WHERE rooftop_key = ? AND match IN ('auto','ambiguous','unmatched')")
    .bind(rooftop).all<any>()).results;
  const writes = rows.map((m) => {
    const d = decide(m.name_raw, m.role_hint, roster);
    return d.staff_id === m.staff_id && d.match === m.match ? null
      : env.DB.prepare("UPDATE mentions SET staff_id = ?, match = ? WHERE id = ?").bind(d.staff_id, d.match, m.id);
  }).filter(Boolean) as D1PreparedStatement[];
  for (let i = 0; i < writes.length; i += 100) await env.DB.batch(writes.slice(i, i + 100));
  return writes.length;
}

/** First instant of a calendar month in Eastern time, as a UTC ISO string. "2026-09" -> 2026-09-01T04:00:00.000Z */
export function etMonthStart(ym: string): string {
  let [y, m] = ym.split("-").map(Number);
  if (m > 12) { y += 1; m = 1; }
  for (const off of [4, 5]) {
    const d = new Date(Date.UTC(y, m - 1, 1, off));
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(d));
    if (h === 0) return d.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, 1, 5)).toISOString();
}

/** [start, end) for a range of calendar months like "2026-07" to "2026-09". */
export function monthRange(from: string, to: string): [string, string] | null {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) return null;
  const [ty, tm] = to.split("-").map(Number);
  return [etMonthStart(from), etMonthStart(`${ty}-${String(tm + 1).padStart(2, "0")}`)];
}

/** Roster lines like "Mike Smith" or "Mike Smith, Mikey, Michael" (nicknames optional).
 *  A second column that names a role ("service", "sales", "advisor") overrides the default role. */
export function parseRosterLines(text: string, defaultRole: StaffRole): { full_name: string; role: StaffRole; aliases: string }[] {
  const roleWord = /^(sales|salesperson|sales consultant|finance|f&i|service|service advisor|advisor|technician|tech|parts|other)$/i;
  return text.split(/\r?\n/).map((line) => line.split(/[,\t]/).map((x) => x.trim()).filter(Boolean)).filter((p) => p.length)
    .map(([name, ...rest]) => {
      let role = defaultRole;
      if (rest.length && roleWord.test(rest[0])) {
        const w = rest.shift()!;
        role = /serv|advis|tech|parts/i.test(w) ? "service" : /sale|financ|f&i/i.test(w) ? "sales" : "other";
      }
      return { full_name: name.slice(0, 80), role, aliases: rest.join(",").slice(0, 200) };
    });
}

export { BudgetExhausted };
