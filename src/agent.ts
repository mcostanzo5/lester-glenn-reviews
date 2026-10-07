import type { Env, ReviewRow, Status } from "./types";
import { ANSWERED, mode, num, nowIso } from "./types";
import { GBPClient, GBPError, type GReview } from "./gbp";
import { matchRooftop, rooftopByKey } from "./rooftops";
import { draftReply } from "./drafter";
import { route } from "./router";
import { Budget, BudgetExhausted, unlimited } from "./budget";

const MAX_NEW_PAGES = 5; // only matters if a store gets 250+ new reviews between runs

export interface RunSummary {
  mode: string; synced: number; drafted: number; posted: number; flagged: number; errors: number; notes: string[];
}

export async function logEvent(env: Env, reviewId: string | null, actor: string, action: string, detail = "") {
  await env.DB.prepare("INSERT INTO events (review_id, actor, action, detail, at) VALUES (?,?,?,?,?)")
    .bind(reviewId, actor, action, detail.slice(0, 2000), nowIso()).run();
}

function isFresh(r: { create_time: string; update_time: string }, days: number): boolean {
  const cutoff = Date.now() - days * 86400_000;
  return Date.parse(r.update_time) >= cutoff || Date.parse(r.create_time) >= cutoff;
}

/** Work out each review's status, then write the whole page in one database batch. */
async function savePage(env: Env, reviews: GReview[], loc: Loc, maxAge: number): Promise<number> {
  if (!reviews.length) return 0;
  const ids = reviews.map((r) => r.id);
  const existing = new Map(
    (await env.DB.prepare(`SELECT id, status, update_time, reply_source FROM reviews WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<{ id: string; status: Status; update_time: string; reply_source: string | null }>()).results.map((r) => [r.id, r])
  );
  const stmt = env.DB.prepare(
    `INSERT INTO reviews (id, location_name, rooftop_key, location_title, stars, text, create_time, update_time,
       status, reply_text, reply_time, reply_source, is_sample, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?)
     ON CONFLICT(id) DO UPDATE SET
       location_name=excluded.location_name, rooftop_key=excluded.rooftop_key, location_title=excluded.location_title,
       stars=excluded.stars, text=excluded.text, create_time=excluded.create_time, update_time=excluded.update_time,
       status=excluded.status, reply_text=excluded.reply_text, reply_time=excluded.reply_time,
       reply_source=excluded.reply_source, synced_at=excluded.synced_at`
  );
  const writes = reviews.map((g) => {
    const ex = existing.get(g.id);
    let status: Status;
    let replySource: string | null = ex?.reply_source ?? null;
    if (g.reply_text) {
      const ours = ex && (ex.status === "auto_posted" || ex.status === "approved_posted");
      status = ours ? ex!.status : "replied_external";
      if (!ours) replySource = "google";
    } else if (!ex) {
      status = isFresh(g, maxAge) ? "new" : "old_unanswered";
    } else if (ex.update_time !== g.update_time || ANSWERED.includes(ex.status)) {
      // Edited by the customer, or our reply was removed: look again
      status = isFresh(g, maxAge) ? "new" : "old_unanswered";
      replySource = null;
    } else {
      status = ex.status;
    }
    return stmt.bind(g.id, loc.name, loc.rooftop_key, loc.title, g.stars, g.text, g.create_time, g.update_time,
      status, g.reply_text, g.reply_time, replySource, nowIso());
  });
  await env.DB.batch(writes);
  return reviews.length;
}

interface Loc {
  name: string; account: string; title: string; rooftop_key: string;
  newest_seen: string | null; backfill_token: string | null; backfill_done: number;
}

async function saveLoc(env: Env, l: Loc) {
  await env.DB.prepare(
    `INSERT INTO locations (name, account_name, title, rooftop_key, newest_seen, backfill_token, backfill_done, updated_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET account_name=excluded.account_name, title=excluded.title,
     rooftop_key=excluded.rooftop_key, newest_seen=excluded.newest_seen, backfill_token=excluded.backfill_token,
     backfill_done=excluded.backfill_done, updated_at=excluded.updated_at`
  ).bind(l.name, l.account, l.title, l.rooftop_key, l.newest_seen, l.backfill_token, l.backfill_done, nowIso()).run();
}

async function loadLocations(env: Env, client: GBPClient): Promise<Loc[]> {
  const saved = new Map((await env.DB.prepare("SELECT * FROM locations").all<any>()).results.map((r) => [r.name, r]));
  const out: Loc[] = [];
  for (const acct of await client.listAccounts()) {
    for (const l of await client.listLocations(acct.name)) {
      const title = l.title || l.name;
      const s = saved.get(l.name);
      out.push({
        name: l.name, account: acct.name, title, rooftop_key: matchRooftop(title).key,
        newest_seen: s?.newest_seen ?? null, backfill_token: s?.backfill_token ?? null, backfill_done: s?.backfill_done ?? 0,
      });
    }
  }
  return out;
}

/** Phase 1: new and edited reviews for every store, newest first. */
async function syncNew(env: Env, client: GBPClient, locs: Loc[], budget: Budget, notes: string[]): Promise<number> {
  const maxAge = num(env.MAX_AGE_DAYS, 14);
  let count = 0;
  for (const loc of locs) {
    if (!budget.has(1)) { notes.push(`Skipped ${loc.title} this run to stay under the request limit.`); continue; }
    try {
      const firstRun = !loc.newest_seen;
      let token: string | undefined;
      let top: string | null = null;
      for (let p = 0; p < MAX_NEW_PAGES && budget.has(1); p++) {
        const page = await client.reviewPage(loc.account, loc.name, token);
        if (!top && page.reviews[0]) top = page.reviews[0].update_time;
        const fresh = loc.newest_seen ? page.reviews.filter((r) => r.update_time > loc.newest_seen!) : page.reviews;
        count += await savePage(env, fresh, loc, maxAge);
        const reachedSeen = fresh.length < page.reviews.length;
        if (firstRun) {
          // Older pages are history; hand them to the backfill phase
          if (page.next) loc.backfill_token = page.next; else loc.backfill_done = 1;
          break;
        }
        if (reachedSeen || !page.next) break;
        token = page.next;
      }
      if (top && (!loc.newest_seen || top > loc.newest_seen)) loc.newest_seen = top;
    } catch (e) {
      if (e instanceof BudgetExhausted) throw e;
      notes.push(`${loc.title}: ${(e as Error).message}`);
    }
    await saveLoc(env, loc);
  }
  return count;
}

/** Last phase: import older history for statistics with whatever budget is left. */
async function backfill(env: Env, client: GBPClient, locs: Loc[], budget: Budget, notes: string[]): Promise<number> {
  const maxAge = num(env.MAX_AGE_DAYS, 14);
  let pagesLeft = num(env.BACKFILL_PAGES_PER_RUN, 20);
  let count = 0;
  for (const loc of locs) {
    if (loc.backfill_done || !loc.backfill_token) continue;
    try {
      while (loc.backfill_token && pagesLeft > 0 && budget.has(1)) {
        const page = await client.reviewPage(loc.account, loc.name, loc.backfill_token);
        count += await savePage(env, page.reviews, loc, maxAge);
        loc.backfill_token = page.next;
        pagesLeft--;
      }
      if (!loc.backfill_token) loc.backfill_done = 1;
    } catch (e) {
      if (!(e instanceof BudgetExhausted)) notes.push(`${loc.title} history: ${(e as Error).message}`);
    }
    await saveLoc(env, loc);
    if (pagesLeft <= 0 || !budget.has(1)) break;
  }
  return count;
}

/** Draft one review and save the result. Returns the new status. */
export async function draftAndRoute(env: Env, r: ReviewRow, actor = "agent", forceReview = false, budget: Budget = unlimited()): Promise<Status> {
  const d = await draftReply(env, r.stars, r.text, rooftopByKey(r.rooftop_key), budget);
  const decision = route(r.stars, r.text, d, num(env.AUTO_POST_MIN_STARS, 4));
  const status: Status = forceReview || decision.action === "review" ? "pending" : "ready";
  await env.DB.prepare(
    `UPDATE reviews SET draft=?, department=?, sentiment=?, risk_level=?, risk_flags=?, route_reason=?, status=? WHERE id=?`
  ).bind(d.reply || null, d.department, d.sentiment, d.risk_level, JSON.stringify(d.risk_flags), decision.reason, status, r.id).run();
  await logEvent(env, r.id, actor, "drafted", decision.reason);
  return status;
}

export async function postReply(env: Env, client: GBPClient, r: ReviewRow, text: string, actor: string, source: "agent" | "manager") {
  await client.postReply(r.id, text);
  const status: Status = source === "agent" ? "auto_posted" : "approved_posted";
  await env.DB.prepare(`UPDATE reviews SET status=?, reply_text=?, reply_time=?, reply_source=? WHERE id=?`)
    .bind(status, text, nowIso(), source, r.id).run();
  await logEvent(env, r.id, actor, "posted", source === "agent" ? "Auto-posted" : "Posted after approval");
}

async function inBatches<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export async function runAgent(env: Env, trigger: string): Promise<RunSummary> {
  const m = mode(env);
  const started = nowIso();
  const s: RunSummary = { mode: m, synced: 0, drafted: 0, posted: 0, flagged: 0, errors: 0, notes: [] };
  const budget = new Budget(num(env.EXTERNAL_REQUEST_BUDGET, 45));
  let client: GBPClient | null = null;
  let locs: Loc[] = [];

  try {
    // 1. New reviews from every store
    if (m !== "dry_run") {
      try {
        client = new GBPClient(env, budget);
        locs = await loadLocations(env, client);
        s.synced += await syncNew(env, client, locs, budget, s.notes);
      } catch (e) {
        if (e instanceof BudgetExhausted) throw e;
        s.errors++; s.notes.push((e as Error).message);
        client = null;
      }
    }

    // 2. Draft what's waiting, keeping one call in reserve per draft for posting when live
    const perDraft = m === "live" ? 2 : 1;
    const sampleClause = m === "dry_run" ? "" : " AND is_sample = 0";
    const limit = Math.min(num(env.MAX_DRAFTS_PER_RUN, 25), Math.floor(budget.left / perDraft));
    if (limit > 0) {
      const waiting = (await env.DB.prepare(`SELECT * FROM reviews WHERE status='new'${sampleClause} ORDER BY create_time DESC LIMIT ?`)
        .bind(limit).all<ReviewRow>()).results;
      await inBatches(waiting, 5, async (r) => {
        const st = await draftAndRoute(env, r, "agent", false, budget);
        s.drafted++;
        if (st === "pending") s.flagged++;
      });
    }

    // 3. Live: post auto-cleared drafts and anything a manager approved
    if (m === "live" && client && budget.has(1)) {
      const toPost = (await env.DB.prepare(
        `SELECT * FROM reviews WHERE status IN ('ready','approved') AND is_sample=0 AND draft IS NOT NULL AND reply_text IS NULL
         ORDER BY status = 'approved' DESC, create_time ASC LIMIT ?`
      ).bind(Math.min(50, budget.left)).all<ReviewRow>()).results;
      for (const r of toPost) {
        try {
          await postReply(env, client, r, r.draft!, r.decided_by || "agent", r.status === "approved" ? "manager" : "agent");
          s.posted++;
        } catch (e) {
          if (e instanceof BudgetExhausted) throw e;
          s.errors++;
          await env.DB.prepare("UPDATE reviews SET status='error', route_reason=? WHERE id=?").bind(`Post failed: ${(e as Error).message}`.slice(0, 500), r.id).run();
        }
      }
    }

    // 4. Older history for statistics, using whatever budget is left
    if (client && locs.length) s.synced += await backfill(env, client, locs, budget, s.notes);
  } catch (e) {
    if (e instanceof BudgetExhausted) s.notes.push(e.message);
    else { s.errors++; s.notes.push((e as Error).message); }
  }

  await env.DB.prepare(
    `INSERT INTO runs (started_at, finished_at, mode, trigger, synced, drafted, posted, flagged, errors, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(started, nowIso(), m, trigger, s.synced, s.drafted, s.posted, s.flagged, s.errors, s.notes.join("\n").slice(0, 4000)).run();
  return s;
}
