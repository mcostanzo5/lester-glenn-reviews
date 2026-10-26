import type { Env, ReviewRow, Status } from "./types";
import { ANSWERED, autoPost, mode, num, nowIso } from "./types";
import { GBPClient, GBPError, type GReview } from "./gbp";
import { matchRooftop, replyRooftop, rooftopByKey, rooftopFor } from "./rooftops";
import { draftReply } from "./drafter";
import { route } from "./router";
import { Budget, BudgetExhausted, unlimited } from "./budget";
import { etDayStart, scanReviews } from "./staff";

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
    (await env.DB.prepare(`SELECT id, status, update_time, reply_source, text, route_reason FROM reviews WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<{ id: string; status: Status; update_time: string; reply_source: string | null; text: string; route_reason: string | null }>()).results.map((r) => [r.id, r])
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
  const sameText = (a: string | null | undefined, b: string | null | undefined) =>
    (a || "").replace(/\s+/g, " ").trim() === (b || "").replace(/\s+/g, " ").trim();
  const restoredByEdit: string[] = [];
  const writes = reviews.map((g) => {
    const ex = existing.get(g.id);
    let status: Status;
    let replySource: string | null = ex?.reply_source ?? null;
    const handRemoved = !!ex && ex.status === "removed" && isHandRemoved(ex.route_reason);
    if (handRemoved && sameText(ex!.text, g.text)) {
      // Marked removed by hand and unchanged: Google's API can keep listing deleted reviews for a while
      status = "removed";
    } else if (handRemoved && g.reply_text) {
      // The reviewer changed what they wrote, so it's a live review again
      restoredByEdit.push(g.id);
      status = "replied_external";
      replySource = "google";
    } else if (handRemoved) {
      restoredByEdit.push(g.id);
      status = isFresh(g, maxAge) ? "new" : "old_unanswered";
      replySource = null;
    } else if (g.reply_text) {
      const ours = ex && (ex.status === "auto_posted" || ex.status === "approved_posted");
      status = ours ? ex!.status : "replied_external";
      if (!ours) replySource = "google";
    } else if (!ex) {
      status = isFresh(g, maxAge) ? "new" : "old_unanswered";
    } else if (ex.update_time !== g.update_time || ANSWERED.includes(ex.status) || ex.status === "removed") {
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
  for (const id of restoredByEdit) {
    await env.DB.prepare("UPDATE reviews SET route_reason = NULL WHERE id = ?").bind(id).run();
    await logEvent(env, id, "agent", "restored", "The reviewer changed the review text, so it's back from removed");
  }
  // Reviews moved by hand to a specific store (from the Auto Group listing) stay there
  try { await env.DB.prepare(`UPDATE reviews SET rooftop_key = rooftop_override WHERE rooftop_override IS NOT NULL AND rooftop_key != rooftop_override AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).run(); }
  catch { /* migration 0009 not run yet */ }
  // Reviewer names are saved separately so syncing keeps working if migration 0007 hasn't been run yet
  try { await env.DB.batch(reviews.map((g) => env.DB.prepare("UPDATE reviews SET reviewer_name = ? WHERE id = ?").bind(g.reviewer_name, g.id))); }
  catch { /* reviewer_name column not added yet */ }
  // If a customer edited their review text, read it again for staff names
  const edited = reviews.filter((g) => existing.has(g.id) && existing.get(g.id)!.text !== g.text);
  if (edited.length) {
    try { await env.DB.batch(edited.map((g) => env.DB.prepare("UPDATE reviews SET mentions_scanned_at = NULL WHERE id = ?").bind(g.id))); }
    catch { /* staff tables not set up yet */ }
  }
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
/** Oldest review date worth importing (HISTORY_START, default Jan 1 2024, Eastern time). */
function historyCutoff(env: Env): string {
  return etDayStart(env.HISTORY_START || "2024-01-01") || etDayStart("2024-01-01")!;
}

/** Reviews in a page that are new enough to keep, and whether the page reached past the cutoff.
 *  Google sorts by last update, newest first, so once one is older than the cutoff, all the rest are too. */
function withinHistory(reviews: GReview[], cutoff: string) {
  return {
    keep: reviews.filter((r) => r.create_time >= cutoff),
    pastCutoff: reviews.some((r) => r.update_time < cutoff),
  };
}

async function syncNew(env: Env, client: GBPClient, locs: Loc[], budget: Budget, notes: string[]): Promise<number> {
  const maxAge = num(env.MAX_AGE_DAYS, 14);
  const cutoff = historyCutoff(env);
  let count = 0;
  let removedCount = 0;
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
        const hist = withinHistory(fresh, cutoff);
        count += await savePage(env, hist.keep, loc, maxAge);
        // Anything we have from the stretch this page covers that Google no longer lists was deleted
        if (p === 0 && !firstRun) {
          const oldest = page.next && page.reviews.length ? page.reviews[page.reviews.length - 1].update_time : null;
          removedCount += await reconcile(env, loc, page.reviews, oldest, null, [], cutoff);
        }
        const reachedSeen = fresh.length < page.reviews.length;
        if (firstRun) {
          // Older pages are history; hand them to the backfill phase unless this page already reached the cutoff
          if (page.next && !hist.pastCutoff) loc.backfill_token = makeBookmark(page.reviews, page.next);
          else { loc.backfill_token = null; loc.backfill_done = 1; }
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
  if (removedCount) notes.push(`${removedCount} recent review${removedCount === 1 ? "" : "s"} no longer on Google, marked as removed.`);
  return count;
}

/** The history import's bookmark: how far back this listing has reached, plus Google's page token.
 *  Stored together in locations.backfill_token as "<oldest date reached>|<token>". */
function readBookmark(t: string | null): { reached: string; token: string } | null {
  if (!t) return null;
  const i = t.indexOf("|");
  return i > 0 && /^\d{4}-/.test(t) ? { reached: t.slice(0, i), token: t.slice(i + 1) } : { reached: "", token: t };
}
function makeBookmark(page: GReview[], next: string | null): string | null {
  if (!next) return null;
  const reached = page.length ? page[page.length - 1].update_time : "";
  return reached ? `${reached}|${next}` : next;
}

/** Last phase: import older history with whatever budget is left, newest first across all listings. */
async function backfill(env: Env, client: GBPClient, locs: Loc[], budget: Budget, notes: string[]): Promise<number> {
  const maxAge = num(env.MAX_AGE_DAYS, 14);
  let pagesLeft = num(env.BACKFILL_PAGES_PER_RUN, 20);
  const cutoff = historyCutoff(env);
  let count = 0;
  let active = locs.filter((l) => !l.backfill_done && l.backfill_token);
  // Each step takes the next page from the listing that has gone back the least, so every
  // store's most recent reviews come in first and all stores move back in time together.
  const reachedOf = (l: Loc) => readBookmark(l.backfill_token)?.reached || "9999"; // unknown = do first
  while (active.length && pagesLeft > 0 && budget.has(1)) {
    const loc = active.reduce((a, b) => (reachedOf(b) > reachedOf(a) ? b : a));
    try {
      const page = await client.reviewPage(loc.account, loc.name, readBookmark(loc.backfill_token)!.token);
      const hist = withinHistory(page.reviews, cutoff);
      count += await savePage(env, hist.keep, loc, maxAge);
      // Stop at the history cutoff; anything older already in the database stays put
      loc.backfill_token = hist.pastCutoff ? null : makeBookmark(page.reviews, page.next);
      if (!loc.backfill_token) loc.backfill_done = 1;
      pagesLeft--;
    } catch (e) {
      if (e instanceof BudgetExhausted) break;
      notes.push(`${loc.title} history: ${(e as Error).message}`);
      active = active.filter((l) => l !== loc); // try this listing again next run
      continue;
    }
    await saveLoc(env, loc);
    if (loc.backfill_done) active = active.filter((l) => l !== loc);
  }
  return count;
}

/** Compares one page from Google with what we have for the same stretch of time.
 *  Reviews we have with an update time inside (lower, upper] that Google didn't list are marked removed;
 *  reviews Google lists that we'd marked removed are restored. Returns how many were marked removed. */
async function reconcile(env: Env, loc: Loc, page: GReview[], lower: string | null, upper: string | null, skip: string[], cutoff: string): Promise<number> {
  const onPage = new Set(page.map((r) => r.id));
  // Bring back anything on this page we'd marked removed (it reappeared, or was a false alarm)
  const back = (await env.DB.prepare(`SELECT id FROM reviews WHERE status = 'removed' AND (route_reason IS NULL OR route_reason NOT LIKE '${HAND_REMOVED}%') AND id IN (${page.map(() => "?").join(",") || "''"})`)
    .bind(...page.map((r) => r.id)).all<{ id: string }>()).results;
  if (back.length) {
    const ids = new Set(back.map((b) => b.id));
    await savePage(env, page.filter((r) => ids.has(r.id)), { ...loc }, num(env.MAX_AGE_DAYS, 14));
    for (const b of back) await logEvent(env, b.id, "agent", "restored", "Listed on Google again");
  }
  const where = ["location_name = ?", "id LIKE 'accounts/%'", "status != 'removed'", "update_time >= ?"];
  const args: unknown[] = [loc.name, cutoff];
  if (lower) { where.push("update_time > ?"); args.push(lower); }
  if (upper) { where.push("update_time <= ?"); args.push(upper); }
  const ours = (await env.DB.prepare(`SELECT id FROM reviews WHERE ${where.join(" AND ")}`).bind(...args).all<{ id: string }>()).results;
  let n = 0;
  for (const r of ours) {
    if (onPage.has(r.id) || skip.includes(r.id)) continue;
    await markRemoved(env, r.id, "agent");
    n++;
  }
  return n;
}

/** Walks each listing's review pages a few at a time, comparing them with what we have, so reviews
 *  deleted long after they were posted are caught too. Bookmarks live in the settings table. */
async function auditSweep(env: Env, client: GBPClient, locs: Loc[], budget: Budget, maxPages: number, notes: string[]) {
  const done = locs.filter((l) => l.backfill_done);
  if (!done.length || maxPages <= 0) return;
  const cutoff = historyCutoff(env);
  const getSetting = async (k: string) => (await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(k).first<{ value: string }>())?.value;
  const setSetting = (k: string, v: string) => env.DB.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?, 'agent', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(k, v, nowIso()).run();
  let start: number;
  try { start = parseInt((await getSetting("audit:next")) || "0", 10) || 0; } catch { return; } // settings table not set up
  let removed = 0, pages = 0, i = start;
  while (pages < maxPages && budget.has(1)) {
    const loc = done[i % done.length];
    i++;
    const key = `audit:${loc.name}`;
    const cur: { token: string | null; upper: string | null; skip: string[] } = JSON.parse((await getSetting(key)) || '{"token":null,"upper":null,"skip":[]}');
    const page = await client.reviewPage(loc.account, loc.name, cur.token || undefined);
    pages++;
    const last = page.reviews[page.reviews.length - 1];
    const pastCutoff = !page.next || page.reviews.some((r) => r.update_time < cutoff);
    const lower = !pastCutoff && last ? last.update_time : null;
    removed += await reconcile(env, loc, page.reviews, lower, cur.upper, cur.skip, cutoff);
    if (pastCutoff || !last) await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run(); // sweep finished; start over next time
    else await setSetting(key, JSON.stringify({ token: page.next, upper: last.update_time, skip: page.reviews.filter((r) => r.update_time === last.update_time).map((r) => r.id) }));
    if (i - start >= done.length * 4) break; // safety: don't loop forever on tiny listings
  }
  await setSetting("audit:next", String(i % done.length));
  if (removed) notes.push(`Found ${removed} older review${removed === 1 ? "" : "s"} no longer on Google, marked as removed.`);
}

export const HAND_REMOVED = "Marked removed by hand";
export const isHandRemoved = (reason: string | null | undefined) => !!reason && reason.startsWith(HAND_REMOVED);

/** Marks a review as removed from Google. */
export async function markRemoved(env: Env, id: string, actor: string) {
  const reason = `Removed from Google (found ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })})`;
  try { await env.DB.prepare("UPDATE reviews SET status='removed', route_reason=?, checked_at=? WHERE id=?").bind(reason, nowIso(), id).run(); }
  catch { await env.DB.prepare("UPDATE reviews SET status='removed', route_reason=? WHERE id=?").bind(reason, id).run(); }
  await logEvent(env, id, actor, "removed", "No longer on Google: deleted by the reviewer or taken down");
}

/** Looks up open reviews on Google, least recently checked first, and marks any that are gone. */
async function verifyStillOnGoogle(env: Env, client: GBPClient, budget: Budget, max: number, notes: string[]) {
  if (max <= 0) return;
  let rows: { id: string }[];
  try {
    rows = (await env.DB.prepare(
      `SELECT id FROM reviews WHERE is_sample = 0 AND id LIKE 'accounts/%' AND status != 'removed'
         AND (escalation_count > 0 OR status IN ('new','pending','ready','approved','error')
              OR (status = 'old_unanswered' AND create_time >= ?))
       ORDER BY (escalation_count > 0) DESC, checked_at IS NOT NULL, checked_at ASC LIMIT ?`)
      .bind(etDayStart(`${new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 4)}-01-01`), max).all<{ id: string }>()).results;
  } catch { return; } // migration 0009 not run yet
  let gone = 0;
  for (const r of rows) {
    if (!budget.has(1)) break;
    try {
      if (await client.reviewExists(r.id)) await env.DB.prepare("UPDATE reviews SET checked_at=? WHERE id=?").bind(nowIso(), r.id).run();
      else { await markRemoved(env, r.id, "agent"); gone++; }
    } catch (e) {
      if (e instanceof BudgetExhausted) throw e;
      // a temporary Google error: try this one again another run
    }
  }
  if (gone) notes.push(`${gone} review${gone === 1 ? "" : "s"} no longer on Google, marked as removed.`);
}

/** Draft one review and save the result. Returns the new status. */
export async function draftAndRoute(env: Env, r: ReviewRow, actor = "agent", forceReview = false, budget: Budget = unlimited()): Promise<Status> {
  const d = await draftReply(env, r.stars, r.text, replyRooftop(r as any), budget, (r as any).reviewer_name);
  // A temporary Claude error during a scheduled or manual run: leave it waiting and try again next run
  if (!d.ok && d.retryable && actor === "agent") {
    await env.DB.prepare("UPDATE reviews SET status='new', route_reason=? WHERE id=?")
      .bind(`Draft will be retried on the next run (${d.risk_flags[0] || "temporary error"})`.slice(0, 300), r.id).run();
    return "new";
  }
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
        if (!locs.length) {
          s.notes.push("Google returned no business locations for this sign-in. The refresh token was probably created with a Google account that doesn't manage the Lester Glenn profiles; create it again signed in as the profile owner or manager.");
        } else {
          s.notes.push(`Found ${locs.length} Google ${locs.length === 1 ? "location" : "locations"}.`);
        }
        s.synced += await syncNew(env, client, locs, budget, s.notes);
      } catch (e) {
        if (e instanceof BudgetExhausted) throw e;
        s.errors++; s.notes.push((e as Error).message);
        client = null;
      }
    }

    // 1b. Make sure reviews that still need attention haven't been deleted on Google
    if (client && budget.left > 14) {
      try { await verifyStillOnGoogle(env, client, budget, Math.min(8, budget.left - 14), s.notes); }
      catch (e) { if (e instanceof BudgetExhausted) throw e; }
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
        `SELECT * FROM reviews WHERE status IN (${autoPost(env) ? "'ready','approved'" : "'approved'"}) AND is_sample=0 AND draft IS NOT NULL AND reply_text IS NULL
         ORDER BY status = 'approved' DESC, create_time ASC LIMIT ?`
      ).bind(Math.min(50, budget.left)).all<ReviewRow>()).results;
      for (const r of toPost) {
        try {
          await postReply(env, client, r, r.draft!, r.decided_by || "agent", r.status === "approved" ? "manager" : "agent");
          s.posted++;
        } catch (e) {
          if (e instanceof BudgetExhausted) throw e;
          if (e instanceof GBPError && e.status === 404) { await markRemoved(env, r.id, "agent"); continue; }
          s.errors++;
          await env.DB.prepare("UPDATE reviews SET status='error', route_reason=? WHERE id=?").bind(`Post failed: ${(e as Error).message}`.slice(0, 500), r.id).run();
        }
      }
    }

    // 4. Read new reviews for staff names (needs migration 0006; skipped quietly until then)
    if (budget.has(2)) {
      try {
        const sc = await scanReviews(env, budget, { maxBatches: 2 });
        if (sc.scanned) s.notes.push(`Read ${sc.scanned} reviews for staff names, found ${sc.found}.`);
      } catch (e) {
        if (e instanceof BudgetExhausted) throw e;
        if (!/no such (table|column)/i.test((e as Error).message)) s.notes.push(`Staff names: ${(e as Error).message}`);
      }
    }

    // 5. Older history for statistics, using whatever budget is left
    if (client && locs.length) s.synced += await backfill(env, client, locs, budget, s.notes);

    // 6. Rolling sweep for reviews deleted from older pages, with what's left
    if (client && locs.length && budget.left > 2) {
      try { await auditSweep(env, client, locs, budget, Math.min(12, budget.left - 2), s.notes); }
      catch (e) { if (e instanceof BudgetExhausted) throw e; }
    }
  } catch (e) {
    if (e instanceof BudgetExhausted) s.notes.push(e.message);
    else { s.errors++; s.notes.push((e as Error).message); }
  }

  await env.DB.prepare(
    `INSERT INTO runs (started_at, finished_at, mode, trigger, synced, drafted, posted, flagged, errors, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(started, nowIso(), m, trigger, s.synced, s.drafted, s.posted, s.flagged, s.errors, s.notes.join("\n").slice(0, 4000)).run();
  return s;
}
