import type { Env, Status } from "./types";
import { nowIso, num } from "./types";
import { Budget, unlimited } from "./budget";
import { rooftopFor, ROOFTOPS } from "./rooftops";
import { logEvent } from "./agent";

// DealerRater and Cars.com reviews through the Cars Commerce Reputation API.
// Reading reviews needs only the API key. Posting a response also needs a short-lived token,
// one per dealer, made from the client ID and secret. Review ids in our database:
//   dr/<DealerRater dealer id>/<review id>     cars/<Cars.com CCID>/<review id>

export type Kind = "dr" | "cars";
const LABEL: Record<Kind, string> = { dr: "DealerRater", cars: "Cars.com" };
const ANSWERED: Status[] = ["auto_posted", "approved_posted", "replied_external"];

export class CarsError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

const base = (env: Env) => (env.CARS_API_BASE || "https://services.dealerrater.com").replace(/\/$/, "");
export const isApiSource = (id: string) => id.startsWith("dr/") || id.startsWith("cars/");
export function externalConfigured(env: Env) { return !!env.CARS_API_KEY; }

export async function getIds(env: Env): Promise<Record<string, { dr?: string; cars?: string }>> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'external_ids'").first<{ value: string }>();
    return row ? JSON.parse(row.value) : {};
  } catch { return {}; }
}

export async function saveIds(env: Env, ids: Record<string, { dr?: string; cars?: string }>, by: string) {
  await env.DB.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('external_ids', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
    .bind(JSON.stringify(ids), by, nowIso()).run();
}

async function call(env: Env, method: string, path: string, opts: { token?: string; json?: unknown; form?: Record<string, string> } = {}, budget: Budget = unlimited()): Promise<any> {
  if (!env.CARS_API_KEY) throw new CarsError("The DealerRater / Cars.com API key isn't set up yet (CARS_API_KEY).");
  budget.take(1);
  const headers: Record<string, string> = { "x-api-key": env.CARS_API_KEY, accept: "application/json" };
  let body: string | undefined;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.json); }
  if (opts.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(opts.form).toString(); }
  const res = await fetch(base(env) + path, { method, headers, body });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || data?.Message || data?.error_description || data?.error || data?.detail || data?.raw || "no details";
    throw new CarsError(`${method} ${path.split("?")[0]} failed (${res.status}): ${String(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 200)}`, res.status);
  }
  return data;
}

const tokens = new Map<string, { token: string; exp: number }>();
async function tokenFor(env: Env, kind: Kind, dealer: string): Promise<string> {
  const scope = `rvw/dealer:${kind}:${dealer}`;
  const hit = tokens.get(scope);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  if (!env.CARS_CLIENT_ID || !env.CARS_CLIENT_SECRET) throw new CarsError("Posting replies needs CARS_CLIENT_ID and CARS_CLIENT_SECRET set as Cloudflare secrets.");
  const d = await call(env, "POST", "/security_v1/token", { form: { grant_type: "client_credentials", client_id: env.CARS_CLIENT_ID, client_secret: env.CARS_CLIENT_SECRET, scope } });
  tokens.set(scope, { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 });
  return d.access_token;
}

interface ExtReview { id: string; stars: number; text: string; create_time: string; reviewer: string; response: { id: string; body: string; at: string } | null; employees: string[] }

function normalize(kind: Kind, dealer: string, r: any, staff: Map<number, any>): ExtReview {
  const ratings = r.Ratings || {};
  const stars = Math.max(0, Math.min(5, Math.round(Number(ratings.Overall ?? ratings.Average ?? 0))));
  const employees = (r.EmployeeTags || []).map((t: any) => staff.get(t.Id)).filter(Boolean)
    .map((e: any) => `${e.FirstName || ""} ${e.LastName || ""}`.trim() + (e.Position ? ` (${e.Position})` : ""));
  const others = String(r.OtherEmployees || "").trim();
  const parts = [r.Title ? String(r.Title).trim() : "", String(r.Body || "").trim()].filter(Boolean);
  if (employees.length || others) parts.push(`Employees worked with: ${[...employees, ...(others ? [others] : [])].join(", ")}`);
  const resp = (r.Responses || []).find((x: any) => !x.FromReviewer && !x.Private);
  return {
    id: `${kind}/${dealer}/${r.Id}`, stars, text: parts.join("\n\n"),
    create_time: new Date(r.Date || Date.now()).toISOString(), reviewer: String(r.UserName || "").trim(),
    response: resp ? { id: String(resp.Id), body: String(resp.Body || ""), at: new Date(resp.DateUpdated || resp.DateEntered || Date.now()).toISOString() } : null,
    employees,
  };
}

async function fetchReviews(env: Env, kind: Kind, dealer: string, budget: Budget, perPage = 50): Promise<ExtReview[]> {
  const path = kind === "dr"
    ? `/review_v1/dealers/d/${encodeURIComponent(dealer)}/consumerreviews?SortOrder=MostRecent&ItemsPerPage=${perPage}`
    : `/review_v1/dealers/c/${encodeURIComponent(dealer)}/consumerreviews?SortOrder=MostRecent&ItemsPerPage=${perPage}&Source=Cars`;
  const d = await call(env, "GET", path, {}, budget);
  const staff = new Map<number, any>((d.Employees || []).map((e: any) => [e.Id, e]));
  return (d.Reviews || []).filter((r: any) => kind === "dr" || r.Source === "Cars" || !r.Source).map((r: any) => normalize(kind, dealer, r, staff));
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a || "").replace(/\s+/g, " ").trim() === (b || "").replace(/\s+/g, " ").trim();

async function upsert(env: Env, rooftop: string, kind: Kind, dealer: string, items: ExtReview[]): Promise<{ added: number; updated: number }> {
  if (!items.length) return { added: 0, updated: 0 };
  const cutoff = new Date(Date.parse((env.HISTORY_START || "2024-01-01") + "T05:00:00Z")).toISOString();
  const maxAge = num(env.MAX_AGE_DAYS, 14);
  const ids = items.map((i) => i.id);
  const existing = new Map((await env.DB.prepare(`SELECT id, status, text, stars, reviewer_updated_at, escalation_count FROM reviews WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all<any>()).results.map((r) => [r.id, r]));
  const name = rooftopFor(rooftop).name;
  let added = 0, updated = 0;
  for (const g of items) {
    const ex = existing.get(g.id);
    if (!ex) {
      if (g.create_time < cutoff) continue;
      const fresh = Date.parse(g.create_time) >= Date.now() - maxAge * 86400_000;
      const status: Status = g.response ? "replied_external" : fresh ? "new" : "old_unanswered";
      await env.DB.prepare(`INSERT INTO reviews (id, location_name, rooftop_key, location_title, stars, text, create_time, update_time, status, is_sample, synced_at,
          source, reviewer_name, reply_text, reply_time, reply_source, ext_response_id) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`)
        .bind(g.id, `${kind}:${dealer}`, rooftop, name, g.stars, g.text, g.create_time, g.create_time, status, nowIso(), LABEL[kind], g.reviewer || null,
          g.response?.body || null, g.response?.at || null, g.response ? "site" : null, g.response?.id || null).run();
      added++;
      continue;
    }
    if (ex.status === "removed") continue;
    if (!same(ex.text, g.text) || (ex.stars && g.stars && ex.stars !== g.stars)) {
      // The reviewer changed their review: back to the Inbox, like Google reviews
      await env.DB.prepare(`UPDATE reviews SET text=?, stars=?, prev_text=?, prev_stars=?, reviewer_updated_at=?, update_time=?, status='new', draft=NULL, route_reason=NULL,
          mentions_scanned_at=NULL, reply_text=COALESCE(?, reply_text), ext_response_id=COALESCE(?, ext_response_id) WHERE id=?`)
        .bind(g.text, g.stars, ex.text, ex.stars, nowIso(), nowIso(), g.response?.body || null, g.response?.id || null, g.id).run();
      if (ex.stars && g.stars && ex.stars !== g.stars) {
        try {
          await env.DB.prepare("INSERT INTO rating_changes (review_id, rooftop_key, old_stars, new_stars, changed_at, after_escalation) VALUES (?,?,?,?,?,?)")
            .bind(g.id, rooftop, ex.stars, g.stars, nowIso(), (ex.escalation_count || 0) > 0 ? 1 : 0).run();
        } catch { /* table missing */ }
      }
      await logEvent(env, g.id, "agent", "review_updated", "The reviewer updated this review");
      updated++;
    } else if (g.response && !ANSWERED.includes(ex.status) && !ex.reviewer_updated_at) {
      // Someone answered it directly on the site
      await env.DB.prepare("UPDATE reviews SET status='replied_external', reply_text=?, reply_time=?, reply_source='site', ext_response_id=? WHERE id=?")
        .bind(g.response.body, g.response.at, g.response.id, g.id).run();
    } else if (g.response) {
      await env.DB.prepare("UPDATE reviews SET ext_response_id=? WHERE id=? AND ext_response_id IS NULL").bind(g.response.id, g.id).run();
    }
  }
  return { added, updated };
}

/** Each run: newest reviews from every configured DealerRater and Cars.com listing, rotating if requests run short. */
export async function syncExternal(env: Env, budget: Budget, notes: string[]): Promise<number> {
  if (!externalConfigured(env)) return 0;
  const map = await getIds(env);
  const jobs: { rooftop: string; kind: Kind; dealer: string }[] = [];
  for (const [rooftop, v] of Object.entries(map)) {
    if (v.dr) jobs.push({ rooftop, kind: "dr", dealer: String(v.dr) });
    if (v.cars) jobs.push({ rooftop, kind: "cars", dealer: String(v.cars) });
  }
  if (!jobs.length) return 0;
  let start = 0;
  try { start = parseInt((await env.DB.prepare("SELECT value FROM settings WHERE key = 'external:next'").first<{ value: string }>())?.value || "0", 10) || 0; } catch { /* */ }
  let done = 0, added = 0, updated = 0;
  const errors: string[] = [];
  for (; done < jobs.length; done++) {
    if (!budget.has(4)) break; // leave room for drafting and posting
    const j = jobs[(start + done) % jobs.length];
    try {
      const r = await upsert(env, j.rooftop, j.kind, j.dealer, await fetchReviews(env, j.kind, j.dealer, budget));
      added += r.added; updated += r.updated;
    } catch (e) {
      errors.push(`${LABEL[j.kind]} (${rooftopFor(j.rooftop).name}): ${(e as Error).message}`);
    }
  }
  try {
    await env.DB.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('external:next', ?, 'agent', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(String((start + done) % jobs.length), nowIso()).run();
  } catch { /* */ }
  if (added) notes.push(`${added} new DealerRater/Cars.com review${added === 1 ? "" : "s"}.`);
  if (updated) notes.push(`${updated} DealerRater/Cars.com review${updated === 1 ? " was" : "s were"} updated by the reviewer.`);
  if (done < jobs.length) notes.push(`DealerRater/Cars.com: checked ${done} of ${jobs.length} listings this run; the rest go next run.`);
  notes.push(...errors.slice(0, 3));
  return added;
}

/** Posts (or replaces) our public response on DealerRater or Cars.com. */
export async function postExternal(env: Env, r: { id: string; ext_response_id?: string | null }, text: string): Promise<string> {
  const [kind, dealer, reviewId] = r.id.split("/") as [Kind, string, string];
  const token = await tokenFor(env, kind, dealer);
  const seg = kind === "dr" ? "d" : "c";
  const path = `/review_v1/dealers/${seg}/${encodeURIComponent(dealer)}/reviews/${encodeURIComponent(reviewId)}/responses`;
  const d = r.ext_response_id
    ? await call(env, "PUT", `${path}/${encodeURIComponent(r.ext_response_id)}`, { token, json: { Body: text } })
    : await call(env, "POST", path, { token, json: { Body: text, Private: false, FromReviewer: false } });
  const newId = String(d?.Response?.Id ?? r.ext_response_id ?? "");
  if (newId) await env.DB.prepare("UPDATE reviews SET ext_response_id = ? WHERE id = ?").bind(newId, r.id).run();
  return newId;
}

/** Settings helpers */
export async function findDealers(env: Env, name: string) {
  const d = await call(env, "GET", `/dealer_v1/dealers/?Name=${encodeURIComponent(name)}&ItemsPerPage=50`);
  return (d.Dealers || []).map((x: any) => ({ id: x.Id, name: x.Name, city: x.City, state: x.State, address: x.Address, phone: x.SalesPhone || x.ServicePhone || "" }));
}

export async function testConnection(env: Env): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  lines.push(`Server: ${base(env)}`);
  try { await call(env, "GET", "/dealer_v1/dealers/?Name=Lester%20Glenn&ItemsPerPage=1"); lines.push("Dealer search (Find our DealerRater IDs): works."); }
  catch (e) {
    ok = false;
    const st = (e as CarsError).status;
    lines.push(`Dealer search (Find our DealerRater IDs): ${(e as Error).message}` +
      (st === 403 ? " The key was rejected for this request: it may be for the other server (production vs staging), not enabled yet, or saved with a typo." : ""));
  }
  const map = await getIds(env);
  const first = Object.entries(map).find(([, v]) => v.dr || v.cars);
  if (!first) { lines.push("Store IDs: none entered yet. Enter one store's DealerRater or Cars.com ID and save, then test again to check reading reviews and posting."); return { ok: false, lines }; }
  const kind: Kind = first[1].dr ? "dr" : "cars";
  const dealer = String(first[1][kind]);
  try { const n = (await fetchReviews(env, kind, dealer, unlimited(), 5)).length; lines.push(`Reading reviews: got ${n} recent review${n === 1 ? "" : "s"} for ${rooftopFor(first[0]).name} (${LABEL[kind]} ${dealer}).`); }
  catch (e) { ok = false; lines.push(`Reading reviews: ${(e as Error).message}`); }
  try { tokens.delete(`rvw/dealer:${kind}:${dealer}`); await tokenFor(env, kind, dealer); lines.push(`Posting replies: token issued for ${rooftopFor(first[0]).name}.`); }
  catch (e) { ok = false; lines.push(`Posting replies: ${(e as Error).message}`); }
  return { ok, lines };
}

export const EXTERNAL_STORES = () => ROOFTOPS;
