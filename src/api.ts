import type { Env, ReviewRow, User } from "./types";
import { autoPost, mode, nowIso } from "./types";
import { canAct, canSee, wasRecipient } from "./auth";
import { ROOFTOPS, DEFAULT_ROOFTOP } from "./rooftops";
import { GBPClient, GBPError } from "./gbp";
import { cleanReply } from "./drafter";
import { draftAndRoute, logEvent, markRemoved, postReply, runAgent } from "./agent";
import { clearSamples, loadSamples } from "./samples";
import { availableReplies, learnGuidelines, MIN_REPLIES } from "./learn";
import { clearGuidelinesCache, currentGuidelines } from "./guidelines";
import { CONCERN_LABEL, FIELDS_FOR, TEAMS_FOR, buildEmail, lastEscalation, getTeams, parseEscalation, resolveEscalation, saveTeams, sendEscalation, type Team } from "./escalate";
import { Budget } from "./budget";
import { canTag, etDayStart, monthRange, norm, parseRosterLines, rematch, scanReviews, type Staff } from "./staff";
import { draftReply } from "./drafter";
import { matchRooftop, replyRooftop, rooftopFor } from "./rooftops";
import { allowedDomains, canSendAs, decryptText, encryptText, checkAddresses, mailConfigured, MailError } from "./mail";

const ANSWERED_SQL = "('auto_posted','approved_posted','replied_external','external_done')";
const OPEN_SQL = "('new','pending','ready','approved','error','old_unanswered','external')";

export const OUTSIDE_SOURCES = ["DealerRater", "Yelp", "Facebook", "Cars.com", "CarGurus", "BBB", "Edmunds", "Autotrader"];

let sourceColReady = false;
/** True once migration 0008 has added the source column (reviews from other sites). */
async function hasSourceCol(env: Env): Promise<boolean> {
  if (sourceColReady) return true;
  try { await env.DB.prepare("SELECT source FROM reviews LIMIT 1").first(); sourceColReady = true; } catch { /* not yet */ }
  return sourceColReady;
}

/** Calendar-day range in Eastern time, end date included. */
function dayRange(startDay: string, endDay: string): { start: string | null; end: string | null } {
  const start = etDayStart(startDay || "");
  let end: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(endDay || "")) {
    end = etDayStart(new Date(Date.parse(endDay + "T12:00:00Z") + 86400_000).toISOString().slice(0, 10));
  }
  return { start, end };
}
/** The Inbox: every review without a reply (dismissed excluded), except that reviews too old
 *  for an automatic draft only show if they're from the current calendar year (Eastern).
 *  Open escalations always show. */
async function inboxWhere(env: Env): Promise<{ sql: string; args: unknown[] }> {
  const year = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 4);
  const yearStart = etDayStart(`${year}-01-01`)!;
  const escalated = (await hasEscalationCols(env)) ? " OR escalation_open > 0" : "";
  return {
    sql: `(status IN ('new','pending','ready','approved','error') OR (status = 'old_unanswered' AND (create_time >= ?${escalated}))${escalated ? " OR (status = 'external' AND escalation_open > 0)" : ""})`,
    args: [yearStart],
  };
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const fail = (message: string, status = 400) => json({ error: message }, status);

/** SQL clause limiting rows to what this user can see. */
function scope(user: User, env: Env, rooftop?: string | null): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (mode(env) !== "dry_run") parts.push("is_sample = 0");
  if (user.rooftops !== "*") {
    parts.push(`rooftop_key IN (${user.rooftops.map(() => "?").join(",") || "''"})`);
    args.push(...user.rooftops);
  }
  if (rooftop) { parts.push("rooftop_key = ?"); args.push(rooftop); }
  return { sql: parts.length ? parts.join(" AND ") : "1=1", args };
}

function visibleRooftops(user: User) {
  const all = [...ROOFTOPS, DEFAULT_ROOFTOP].map((r) => ({ key: r.key, name: r.name, town: r.town }));
  return user.rooftops === "*" ? all : all.filter((r) => (user.rooftops as string[]).includes(r.key));
}

/** Next top-of-hour that falls on one of RUN_HOURS_ET in New York. */
function nextScheduledRun(hours = "8,12,16,20"): string | null {
  const wanted = hours.split(",").map((h) => Number(h.trim()));
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
  const t = new Date();
  t.setUTCMinutes(0, 0, 0);
  for (let i = 1; i <= 48; i++) {
    const c = new Date(t.getTime() + i * 3600_000);
    if (wanted.includes(Number(fmt.format(c)))) return c.toISOString();
  }
  return null;
}

async function me(env: Env, user: User) {
  const s = scope(user, env);
  const inbox = await inboxWhere(env);
  const counts = (await env.DB.prepare(
    `SELECT rooftop_key, COUNT(*) n FROM reviews WHERE ${s.sql} AND ${inbox.sql} GROUP BY rooftop_key`
  ).bind(...s.args, ...inbox.args).all<{ rooftop_key: string; n: number }>()).results;
  const map = Object.fromEntries(counts.map((c) => [c.rooftop_key, c.n]));
  let escalations: number | null = null;
  try {
    escalations = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE ${s.sql} AND escalation_open > 0`)
      .bind(...s.args).first<{ n: number }>())?.n ?? 0;
  } catch { /* escalation columns not added yet */ }
  const lastRun = await env.DB.prepare("SELECT finished_at, trigger, errors FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1")
    .first<{ finished_at: string; trigger: string; errors: number }>();
  return json({
    email: user.email, name: user.name, role: user.role, canReply: user.canReply, mode: mode(env), autoPost: autoPost(env), escalations,
    lastRun: lastRun ? { at: lastRun.finished_at, manual: lastRun.trigger.startsWith("manual"), errors: lastRun.errors } : null,
    nextRun: mode(env) === "dry_run" ? null : nextScheduledRun(env.RUN_HOURS_ET),
    approvers: (env.REPLY_APPROVERS || "").split(",").map((e) => e.trim()).filter(Boolean),
    sources: OUTSIDE_SOURCES,
    storeNames: Object.fromEntries([...ROOFTOPS, DEFAULT_ROOFTOP].map((r) => [r.key, r.name])),
    rooftops: visibleRooftops(user).map((r) => ({ ...r, open: map[r.key] || 0 })),
  });
}

async function listReviews(env: Env, user: User, url: URL) {
  const view = url.searchParams.get("view") || "inbox";
  const s = scope(user, env, url.searchParams.get("rooftop"));
  const where = [s.sql];
  const args = [...s.args];
  const status = url.searchParams.get("status");
  if (view === "inbox") { const inbox = await inboxWhere(env); where.push(inbox.sql); args.push(...inbox.args); }
  else if (view === "escalations") where.push("escalation_open > 0");
  else if (status === "open") where.push(`status IN ${OPEN_SQL}`);
  else if (status === "answered") where.push(`status IN ${ANSWERED_SQL}`);
  else if (status) { where.push("status = ?"); args.push(status); }
  const days = parseInt(url.searchParams.get("days") || "", 10);
  if (days > 0) { where.push("create_time >= ?"); args.push(new Date(Date.now() - days * 86400_000).toISOString()); }
  // Custom range: whole days in Eastern time, end date included
  const days2 = dayRange(url.searchParams.get("start") || "", url.searchParams.get("end") || "");
  if (days2.start) { where.push("create_time >= ?"); args.push(days2.start); }
  if (days2.end) { where.push("create_time < ?"); args.push(days2.end); }
  const src = url.searchParams.get("source");
  if (src && (await hasSourceCol(env))) where.push(src === "google" ? "source IS NULL" : "source IS NOT NULL");
  const stars = url.searchParams.get("stars");
  if (stars === "low") where.push("stars <= 3");
  else if (stars === "high") where.push("stars >= 4");
  const staffId = parseInt(url.searchParams.get("staff") || "", 10);
  if (staffId) { where.push("id IN (SELECT review_id FROM mentions WHERE staff_id = ? AND match IN ('auto','manual'))"); args.push(staffId); }
  const range = monthRange(url.searchParams.get("from") || "", url.searchParams.get("to") || "");
  if (range) { where.push("create_time >= ? AND create_time < ?"); args.push(range[0], range[1]); }
  const q = (url.searchParams.get("q") || "").trim();
  if (q) {
    const byName = await hasReviewerNames(env);
    where.push(`(text LIKE ? OR draft LIKE ? OR reply_text LIKE ?${byName ? " OR reviewer_name LIKE ?" : ""})`);
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, ...(byName ? [`%${q}%`] : []));
  }
  const page = Math.max(0, parseInt(url.searchParams.get("page") || "0", 10) || 0);
  // Inbox order: open escalations, flagged, failed posts, waiting for a draft, drafts ready, approved, older unanswered
  const order = view === "inbox" ? `CASE WHEN ${await hasEscalationCols(env) ? "escalation_open > 0" : "0"} THEN 0 ELSE 1 END,
      CASE status WHEN 'pending' THEN 0 WHEN 'error' THEN 1 WHEN 'new' THEN 2 WHEN 'ready' THEN 3 WHEN 'approved' THEN 4 ELSE 5 END, create_time DESC`
    : view === "escalations" ? "escalation_first_at ASC" // longest-waiting first
    : "create_time DESC";
  const rows = (await env.DB.prepare(`SELECT * FROM reviews WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 51 OFFSET ?`)
    .bind(...args, page * 50).all<ReviewRow>()).results;
  for (const row of rows) delete (row as any).escalation_details;
  return json({ reviews: rows.slice(0, 50), more: rows.length > 50, page });
}

let escalationColsReady = false;
async function hasEscalationCols(env: Env): Promise<boolean> {
  if (escalationColsReady) return true;
  try { await env.DB.prepare("SELECT escalation_open FROM reviews LIMIT 1").first(); escalationColsReady = true; } catch { /* not yet */ }
  return escalationColsReady;
}

let reviewerNamesReady = false;
/** True once migration 0007 has added the reviewer_name column. */
async function hasReviewerNames(env: Env): Promise<boolean> {
  if (reviewerNamesReady) return true;
  try { await env.DB.prepare("SELECT reviewer_name FROM reviews LIMIT 1").first(); reviewerNamesReady = true; } catch { /* not yet */ }
  return reviewerNamesReady;
}

/** Writes a reply using the review plus any management notes. Returns an error message, or null. */
async function draftWithNotes(env: Env, r: ReviewRow, user: User, requireNotes: boolean): Promise<string | null> {
  let notes: string[] = [];
  try {
    const rows = (await env.DB.prepare("SELECT body FROM review_notes WHERE review_id = ? ORDER BY id").bind(r.id).all<{ body: string }>()).results;
    notes = (await Promise.all(rows.map((n) => decryptText(env, n.body)))).filter(Boolean) as string[];
  } catch { /* notes table not set up */ }
  if (requireNotes && !notes.length) return "Add the management notes first, then draft.";
  const source = (r as any).source as string | null;
  const d = await draftReply(env, r.stars, r.text, replyRooftop(r as any), undefined, (r as any).reviewer_name, { notes, source: source || undefined });
  if (!d.ok) return `The draft didn't work: ${d.risk_flags[0] || "unknown problem"}. Try again.`;
  const reason = notes.length ? `Drafted with ${notes.length} management note${notes.length === 1 ? "" : "s"}` : "Redrafted";
  // Replies drafted with notes always wait for an approver; outside reviews stay outside
  const status = source ? "external" : "pending";
  await env.DB.prepare("UPDATE reviews SET draft=?, department=?, sentiment=?, risk_level=?, risk_flags=?, route_reason=?, status=? WHERE id=?")
    .bind(d.reply, d.department, d.sentiment, d.risk_level, JSON.stringify(d.risk_flags), reason, status, r.id).run();
  await logEvent(env, r.id, user.email, "drafted", reason);
  return null;
}

/** Checks one review on Google right now: marks it removed if it's gone, or restores it if it's back. */
async function verifyReview(env: Env, user: User, r: ReviewRow): Promise<Response> {
  if (!r.id.startsWith("accounts/")) return fail("Only Google reviews can be checked on Google.");
  let exists: boolean;
  try { exists = await new GBPClient(env).reviewExists(r.id); }
  catch (e) { return fail(`Couldn't check with Google: ${(e as Error).message}`, 502); }
  if (!exists) {
    if (r.status !== "removed") await markRemoved(env, r.id, user.email);
  } else {
    try { await env.DB.prepare("UPDATE reviews SET checked_at=? WHERE id=?").bind(nowIso(), r.id).run(); } catch { /* migration 0009 */ }
    if (r.status === "removed") {
      await env.DB.prepare("UPDATE reviews SET status=?, route_reason=NULL WHERE id=?").bind(r.reply_text ? "replied_external" : "new", r.id).run();
      await logEvent(env, r.id, user.email, "restored", "Back on Google");
    }
  }
  const d = await reviewDetail(env, user, r.id);
  const data: any = await d.json();
  return json({ ...data, checked: exists ? "Still on Google." : "Not on Google anymore. Marked as removed." });
}

/** Moves a review on the Auto Group listing to the store it's really about (for stats, escalations and staff tags).
 *  The reply still comes from the Auto Group listing, since that's where it's posted. */
async function reassignReview(env: Env, user: User, r: ReviewRow, rooftop: string): Promise<Response> {
  const listingKey = matchRooftop(r.location_title || "").key;
  if (!["group", "other"].includes(listingKey)) return fail("Only reviews on the Lester Glenn Auto Group listing can be moved to a store.");
  const back = !rooftop || rooftop === listingKey;
  if (!back && !ROOFTOPS.some((x) => x.key === rooftop && !["group"].includes(x.key))) return fail("Pick a store.");
  const target = back ? listingKey : rooftop;
  try {
    await env.DB.prepare("UPDATE reviews SET rooftop_key=?, rooftop_override=? WHERE id=?").bind(target, back ? null : target, r.id).run();
  } catch { return fail("One-time setup needed: run migrations/0009_removed_and_reassigned.sql in the D1 console.", 503); }
  // Staff names get matched against the new store's roster
  try {
    await env.DB.prepare("DELETE FROM mentions WHERE review_id = ?").bind(r.id).run();
    await env.DB.prepare("UPDATE reviews SET mentions_scanned_at = NULL WHERE id = ?").bind(r.id).run();
  } catch { /* staff tables not set up */ }
  await logEvent(env, r.id, user.email, "reassigned", back ? "Moved back to the Auto Group listing" : `Moved to ${rooftopFor(target).name}`);
  return reviewDetail(env, user, r.id);
}

/** Adds a review from another site by hand, ready to escalate. */
async function createManualReview(env: Env, user: User, body: any): Promise<Response> {
  if (!(await hasSourceCol(env))) return fail("One-time setup needed: run migrations/0008_manual_reviews_and_notes.sql in the D1 console.", 503);
  const rooftop = String(body?.rooftop || "");
  if (![...ROOFTOPS].some((r) => r.key === rooftop)) return fail("Pick a store.");
  if (!canAct(user, rooftop)) return fail("You can't add reviews for that store.", 403);
  let source = String(body?.source || "").trim();
  if (source === "Other") source = String(body?.source_other || "").trim();
  if (!source) return fail("Pick where the review was posted.");
  source = source.slice(0, 40);
  const text = String(body?.text || "").trim().slice(0, 10000);
  if (!text) return fail("Paste the review text.");
  const stars = Math.max(0, Math.min(5, parseInt(body?.stars, 10) || 0));
  const url = String(body?.url || "").trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) return fail("The link should start with http:// or https://");
  const day = String(body?.date || "");
  const dayStart = etDayStart(day);
  if (dayStart && dayStart > nowIso()) return fail("The review date can't be in the future.");
  // Midday Eastern on the date given, or right now if that's still ahead (today's reviews)
  const noon = dayStart ? new Date(Date.parse(dayStart) + 12 * 3600_000).toISOString() : nowIso();
  const when = noon > nowIso() ? nowIso() : noon;
  const id = `manual/${crypto.randomUUID()}`;
  const name = rooftopFor(rooftop).name;
  await env.DB.prepare(`INSERT INTO reviews (id, location_name, rooftop_key, location_title, stars, text, create_time, update_time, status, is_sample, synced_at, source, source_url)
    VALUES (?,?,?,?,?,?,?,?, 'external', 0, ?, ?, ?)`).bind(id, null, rooftop, name, stars, text, when, when, nowIso(), source, url || null).run();
  const reviewer = String(body?.reviewer_name || "").trim().slice(0, 120);
  if (reviewer) { try { await env.DB.prepare("UPDATE reviews SET reviewer_name = ? WHERE id = ?").bind(reviewer, id).run(); } catch { /* column not added */ } }
  await logEvent(env, id, user.email, "added", `Added by hand from ${source}`);
  return json({ id });
}

async function getReview(env: Env, id: string): Promise<ReviewRow | null> {
  return env.DB.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first<ReviewRow>();
}

async function reviewDetail(env: Env, user: User, id: string) {
  const r = await getReview(env, id);
  const linkOk = user.role === "link" && r ? await wasRecipient(env, user.email, id) : false;
  if (!r || !(canSee(user, r.rooftop_key) || linkOk)) {
    return fail(user.role === "link"
      ? "This review wasn't sent to you, so it can't be opened here. Ask the person who sent it, or an admin, for access."
      : "Review not found.", 404);
  }
  if (user.role === "link") { r.draft = null; r.route_reason = null; r.risk_flags = null; (r as any).reviewer_name = null; }
  const events = (await env.DB.prepare("SELECT actor, action, detail, at FROM events WHERE review_id = ? ORDER BY id DESC LIMIT 50").bind(id).all()).results;
  let escalation: any = { ready: false };
  try {
    const sent = (await env.DB.prepare("SELECT concern, recipients, followup_number, sent_by, sent_at FROM escalations WHERE review_id = ? ORDER BY id DESC LIMIT 25").bind(id).all()).results;
    escalation = {
      ready: true, mailReady: mailConfigured(env), canSend: await canSendAs(env, user.email), domains: allowedDomains(env),
      teams: canAct(user, r.rooftop_key) ? await getTeams(env, r.rooftop_key) : null,
      teamsFor: TEAMS_FOR, fieldsFor: FIELDS_FOR, labels: CONCERN_LABEL, sent,
      last: canAct(user, r.rooftop_key) || linkOk ? await lastEscalation(env, r) : null,
    };
  } catch { /* migration 0003 not run yet */ }
  delete (r as any).escalation_details;
  let staff: any = null;
  if (user.role !== "link") {
    try {
      const mentions = (await env.DB.prepare(`SELECT m.id, m.name_raw, m.role_hint, m.sentiment, m.match, m.staff_id, s.full_name, s.role
        FROM mentions m LEFT JOIN staff s ON s.id = m.staff_id WHERE m.review_id = ? ORDER BY m.id`).bind(id).all()).results;
      staff = {
        mentions, scanned: !!(r as any).mentions_scanned_at, canTag: canTag(user) && canSee(user, r.rooftop_key),
        roster: canTag(user) ? (await env.DB.prepare("SELECT id, full_name, role, aliases, active FROM staff WHERE rooftop_key = ? ORDER BY full_name").bind(r.rooftop_key).all()).results : [],
      };
    } catch { /* migration 0006 not run yet */ }
  }
  let notes: any[] | null = null;
  try {
    const rows = (await env.DB.prepare("SELECT id, author, author_name, body, created_at FROM review_notes WHERE review_id = ? ORDER BY id")
      .bind(id).all<any>()).results;
    notes = await Promise.all(rows.map(async (n) => ({ ...n, body: (await decryptText(env, n.body)) ?? "(This note can't be read; it was saved before the app's key changed.)" })));
  } catch { /* migration 0008 not run yet */ }
  const listingKey = matchRooftop(r.location_title || "").key;
  const reassign = r.id.startsWith("accounts/") && ["group", "other"].includes(listingKey) && (user.role === "admin" || user.canReply)
    ? { listing: r.location_title, moved: !!(r as any).rooftop_override } : null;
  return json({ review: r, reassign, events, escalation, staff, notes, canNote: user.role !== "link" && (canAct(user, r.rooftop_key) || user.canReply) });
}

async function reviewAction(env: Env, user: User, id: string, action: string, body: any, origin: string) {
  const r = await getReview(env, id);
  if (!r || !canSee(user, r.rooftop_key)) return fail("Review not found.", 404);
  const replyActions = ["save", "approve", "dismiss", "reopen", "redraft", "draftnotes", "responded"];
  if (action === "verify" || action === "reassign") {
    if (!(user.role === "admin" || user.canReply)) return fail("Only admins and reply approvers can do that.", 403);
    return action === "verify" ? verifyReview(env, user, r) : reassignReview(env, user, r, String(body?.rooftop || ""));
  }
  if (replyActions.includes(action) && !user.canReply) {
    return fail(`Only ${(env.REPLY_APPROVERS || "the reply approvers").split(",").join(" and ")} can change replies.`, 403);
  }
  if (action === "note" || action === "delnote") {
    if (user.role === "link" || !(canAct(user, r.rooftop_key) || user.canReply)) return fail("You can't add notes to this review.", 403);
  } else if (!replyActions.includes(action) && !canAct(user, r.rooftop_key)) return fail("You have view-only access to this store.", 403);
  const outside = !!(r as any).source;
  const reply = typeof body?.reply === "string" ? cleanReply(body.reply) : "";

  if (action === "save") {
    if (!reply) return fail("Write a reply before saving.");
    await env.DB.prepare("UPDATE reviews SET draft = ? WHERE id = ?").bind(reply, id).run();
    await logEvent(env, id, user.email, "edited");
  } else if (action === "approve" && outside) {
    return fail(`This review is on ${(r as any).source}, so it can't be posted from here. Copy the reply, post it there, then click Mark as responded.`);
  } else if (action === "responded") {
    if (!outside) return fail("Only reviews from other sites are marked as responded by hand.");
    await env.DB.prepare("UPDATE reviews SET status='external_done', draft=COALESCE(?, draft), reply_text=COALESCE(?, draft), reply_time=?, reply_source='manager', decided_by=?, decided_at=? WHERE id=?")
      .bind(reply || null, reply || null, nowIso(), user.email, nowIso(), id).run();
    await logEvent(env, id, user.email, "responded", `Responded on ${(r as any).source}`);
  } else if (action === "approve") {
    if (!reply) return fail("Write a reply before approving.");
    if (["auto_posted", "approved_posted", "replied_external"].includes(r.status)) return fail("This review already has a reply.");
    await env.DB.prepare("UPDATE reviews SET draft=?, decided_by=?, decided_at=? WHERE id=?").bind(reply, user.email, nowIso(), id).run();
    if (mode(env) === "live" && !r.is_sample) {
      try { await postReply(env, new GBPClient(env), r, reply, user.email, "manager"); }
      catch (e) {
        if (e instanceof GBPError && e.status === 404) {
          await markRemoved(env, id, user.email);
          return fail("This review is no longer on Google (the reviewer deleted it or Google took it down), so there's nothing to reply to. It's been marked as removed.", 410);
        }
        return fail(`Google didn't accept the reply: ${(e as Error).message}`, 502);
      }
    } else {
      await env.DB.prepare("UPDATE reviews SET status='approved' WHERE id=?").bind(id).run();
      await logEvent(env, id, user.email, "approved", "Will post when the agent is live");
    }
  } else if (action === "dismiss") {
    await env.DB.prepare("UPDATE reviews SET status='dismissed', decided_by=?, decided_at=? WHERE id=?").bind(user.email, nowIso(), id).run();
    await logEvent(env, id, user.email, "dismissed", String(body?.note || "").slice(0, 500));
  } else if (action === "reopen") {
    await env.DB.prepare("UPDATE reviews SET status=? WHERE id=?").bind(outside ? "external" : "pending", id).run();
    await logEvent(env, id, user.email, "reopened");
  } else if (action === "escalate") {
    const parsed = parseEscalation(env, body);
    if (!parsed.input) return fail(parsed.error!);
    if (body?.preview) {
      const email = buildEmail(r, parsed.input, user, origin, nowIso());
      return json({ subject: email.subject, html: email.html, recipients: parsed.input.recipients, from: user.email });
    }
    try { await sendEscalation(env, r, parsed.input, user, origin); }
    catch (e) {
      if (e instanceof MailError && e.needsSignIn) return json({ error: e.message, signIn: true }, 409);
      return fail((e as Error).message, e instanceof MailError ? 502 : 500);
    }
  } else if (action === "resolve") {
    await resolveEscalation(env, r, user);
  } else if (action === "redraft" && outside) {
    const err = await draftWithNotes(env, r, user, false);
    if (err) return fail(err, 502);
  } else if (action === "draftnotes") {
    const err = await draftWithNotes(env, r, user, true);
    if (err) return fail(err, 502);
  } else if (action === "note") {
    const text = String(body?.body || "").replace(/\s*\u2014\s*/g, ", ").trim().slice(0, 8000);
    if (!text) return fail("Paste or type the note first.");
    await env.DB.prepare("INSERT INTO review_notes (review_id, author, author_name, body, created_at) VALUES (?,?,?,?,?)")
      .bind(id, user.email, user.name || null, await encryptText(env, text), nowIso()).run();
    await logEvent(env, id, user.email, "note_added");
  } else if (action === "delnote") {
    const n = await env.DB.prepare("SELECT author FROM review_notes WHERE id = ? AND review_id = ?").bind(Number(body?.note_id), id).first<{ author: string }>();
    if (!n) return fail("Note not found.", 404);
    if (n.author !== user.email && user.role !== "admin") return fail("Only the person who added a note, or an admin, can remove it.", 403);
    await env.DB.prepare("DELETE FROM review_notes WHERE id = ?").bind(Number(body?.note_id)).run();
    await logEvent(env, id, user.email, "note_removed");
  } else if (action === "deletemanual") {
    if (!outside) return fail("Only reviews added by hand can be deleted.");
    for (const sql of ["DELETE FROM review_notes WHERE review_id = ?", "DELETE FROM mentions WHERE review_id = ?", "DELETE FROM escalations WHERE review_id = ?", "DELETE FROM events WHERE review_id = ?", "DELETE FROM reviews WHERE id = ?"]) {
      try { await env.DB.prepare(sql).bind(id).run(); } catch { /* table not set up */ }
    }
    return json({ deleted: true });
  } else if (action === "redraft") {
    await draftAndRoute(env, r, user.email, true);
  } else {
    return fail("Unknown action.", 404);
  }
  return reviewDetail(env, user, id);
}

async function stats(env: Env, user: User, url: URL) {
  const days = parseInt(url.searchParams.get("days") || "90", 10) || 0;
  const s = scope(user, env, url.searchParams.get("rooftop"));
  const parts = [s.sql];
  const args: unknown[] = [...s.args];
  const range = dayRange(url.searchParams.get("start") || "", url.searchParams.get("end") || "");
  if (range.start || range.end) {
    if (range.start) { parts.push("create_time >= ?"); args.push(range.start); }
    if (range.end) { parts.push("create_time < ?"); args.push(range.end); }
  } else if (days > 0) {
    parts.push("create_time >= ?"); args.push(new Date(Date.now() - days * 86400_000).toISOString());
  }
  // Statistics are about Google reviews; reviews added by hand from other sites are left out
  if (await hasSourceCol(env)) parts.push("source IS NULL");
  parts.push("status != 'removed'");
  const where = parts.join(" AND ");
  const hours = "(julianday(reply_time) - julianday(create_time)) * 24";
  const metrics = `
    COUNT(*) AS total,
    ROUND(AVG(NULLIF(stars,0)), 2) AS avg_stars,
    SUM(status IN ${ANSWERED_SQL}) AS answered,
    ROUND(AVG(CASE WHEN status IN ${ANSWERED_SQL} AND reply_time IS NOT NULL THEN ${hours} END), 1) AS avg_hours,
    SUM(status IN ${ANSWERED_SQL} AND reply_time IS NOT NULL AND ${hours} <= 24) AS within_24,
    SUM(status IN ${OPEN_SQL}) AS open,
    SUM(reply_source = 'agent') AS by_agent,
    SUM(reply_source = 'manager') AS by_manager,
    SUM(reply_source = 'google') AS by_google,
    SUM(stars <= 3) AS low_star`;
  const q = (sql: string) => env.DB.prepare(sql).bind(...args);
  const [overall, byRooftop, monthly, starsDist] = await env.DB.batch([
    q(`SELECT ${metrics} FROM reviews WHERE ${where}`),
    q(`SELECT rooftop_key, ${metrics}, MIN(CASE WHEN status IN ${OPEN_SQL} THEN create_time END) AS oldest_open
       FROM reviews WHERE ${where} GROUP BY rooftop_key`),
    q(`SELECT strftime('%Y-%m', create_time) AS month, ${metrics} FROM reviews WHERE ${where} GROUP BY month ORDER BY month`),
    q(`SELECT stars, COUNT(*) AS n FROM reviews WHERE ${where} GROUP BY stars`),
  ]);
  const names = Object.fromEntries([...ROOFTOPS, DEFAULT_ROOFTOP].map((r) => [r.key, r.name]));
  return json({
    days,
    overall: overall.results[0],
    rooftops: (byRooftop.results as any[]).map((r) => ({ ...r, name: names[r.rooftop_key] || r.rooftop_key })),
    monthly: monthly.results,
    stars: starsDist.results,
  });
}

async function admin(env: Env, user: User, req: Request, path: string, url: URL, body: any) {
  if (user.role !== "admin") return fail("Only admins can do that.", 403);
  if (path === "/api/admin/run" && req.method === "POST") return json(await runAgent(env, `manual:${user.email}`));
  if (path === "/api/admin/samples" && req.method === "POST") {
    if (body?.action === "clear") { await clearSamples(env); return json({ ok: true }); }
    if (mode(env) !== "dry_run") return fail("Sample data can only be loaded in dry run mode.");
    return json({ ok: true, loaded: await loadSamples(env) });
  }
  if (path === "/api/admin/users") {
    if (req.method === "GET") {
      const users = (await env.DB.prepare("SELECT * FROM users ORDER BY email").all()).results;
      const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim()).filter(Boolean);
      return json({ users, builtInAdmins: admins, rooftops: visibleRooftops(user) });
    }
    if (req.method === "POST") {
      const email = String(body?.email || "").trim().toLowerCase();
      const role = String(body?.role || "");
      const rooftops = Array.isArray(body?.rooftops) && body.rooftops.length ? body.rooftops.join(",") : "*";
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter a valid email address.");
      if (!["admin", "manager", "viewer"].includes(role)) return fail("Pick a role.");
      await env.DB.prepare(`INSERT INTO users (email, role, rooftops, added_by, added_at) VALUES (?,?,?,?,?)
        ON CONFLICT(email) DO UPDATE SET role=excluded.role, rooftops=excluded.rooftops`).bind(email, role, rooftops, user.email, nowIso()).run();
      return json({ ok: true });
    }
    if (req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM users WHERE email = ?").bind((url.searchParams.get("email") || "").toLowerCase()).run();
      return json({ ok: true });
    }
  }
  if (path === "/api/admin/guidelines" && req.method === "GET") {
    const g = await currentGuidelines(env, true);
    let meta: any = null;
    try { meta = await env.DB.prepare("SELECT updated_by, updated_at FROM settings WHERE key = 'guidelines'").first(); }
    catch { return json({ text: g.text, custom: false, needsSetup: true, available: 0, minReplies: MIN_REPLIES }); }
    return json({ text: g.text, custom: g.custom, updatedBy: meta?.updated_by, updatedAt: meta?.updated_at,
      available: await availableReplies(env), minReplies: MIN_REPLIES });
  }
  if (path === "/api/admin/guidelines/learn" && req.method === "POST") {
    const r = await learnGuidelines(env, body?.source === "pasted" ? "pasted" : "google", String(body?.text || ""));
    return r.error ? fail(r.error, 400) : json(r);
  }
  if (path === "/api/admin/guidelines" && req.method === "POST") {
    const save = env.DB.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`);
    const current = await env.DB.prepare("SELECT value FROM settings WHERE key = 'guidelines'").first<{ value: string }>().catch(() => null);
    if (body?.action === "reset") {
      if (current) await env.DB.batch([save.bind("guidelines_previous", current.value, user.email, nowIso()),
        env.DB.prepare("DELETE FROM settings WHERE key = 'guidelines'")]);
    } else {
      const text = String(body?.text || "").replace(/\s*\u2014\s*/g, ", ").trim();
      if (text.length < 200) return fail("The guidelines look too short to save.");
      if (text.length > 30_000) return fail("The guidelines are too long. Keep them under 30,000 characters.");
      const writes = [save.bind("guidelines", text, user.email, nowIso())];
      if (current) writes.unshift(save.bind("guidelines_previous", current.value, user.email, nowIso()));
      await env.DB.batch(writes);
    }
    clearGuidelinesCache();
    await logEvent(env, null, user.email, body?.action === "reset" ? "guidelines_reset" : "guidelines_saved");
    return json({ ok: true });
  }
  if (path === "/api/admin/teams" && req.method === "GET") {
    try {
      const rows = (await env.DB.prepare("SELECT rooftop_key, team, emails, updated_by, updated_at FROM team_lists").all<any>()).results;
      return json({ ready: true, rows, domains: allowedDomains(env), mailReady: mailConfigured(env) });
    } catch { return json({ ready: false }); }
  }
  if (path === "/api/admin/teams" && req.method === "POST") {
    const rooftop = String(body?.rooftop || "");
    if (![...ROOFTOPS, DEFAULT_ROOFTOP].some((r) => r.key === rooftop)) return fail("Pick a store.");
    const lists = {} as Record<Team, string[]>;
    for (const t of ["sales", "service", "store"] as Team[]) {
      const { ok, bad } = checkAddresses(env, body?.[t]);
      if (bad.length) return fail(`Can't use: ${bad.join(", ")}. Only ${allowedDomains(env).join(", ")} addresses are allowed.`);
      lists[t] = ok;
    }
    await saveTeams(env, rooftop, lists, user.email);
    return json({ ok: true });
  }
  if (path === "/api/admin/runs") {
    const [runs, locs] = await env.DB.batch([
      env.DB.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 20"),
      env.DB.prepare("SELECT title, rooftop_key, newest_seen, backfill_done, updated_at FROM locations ORDER BY title"),
    ]);
    return json({ runs: runs.results, locations: locs.results, mode: mode(env) });
  }
  return fail("Not found.", 404);
}

export async function handleApi(req: Request, env: Env, user: User): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  let body: any = null;
  if (req.method !== "GET") {
    // Custom header blocks cross-site form posts
    if (req.headers.get("x-requested-with") !== "reviews-app") return fail("Missing request header.", 400);
    body = await req.json().catch(() => ({}));
  }
  if (path === "/api/me") return me(env, user);
  if (user.role === "link" && !(req.method === "GET" && /^\/api\/reviews\/[^/]+$/.test(path))) {
    return fail("You can open reviews from escalation emails. Ask an admin if you need dashboard access.", 403);
  }
  if (path === "/api/reviews" && req.method === "GET") return listReviews(env, user, url);
  if (path === "/api/reviews" && req.method === "POST") return createManualReview(env, user, body);
  if (path === "/api/stats") return stats(env, user, url);
  if (path.startsWith("/api/admin/")) return admin(env, user, req, path, url, body);
  if (path.startsWith("/api/staff")) return staffApi(env, user, req, path, url, body);
  const m = path.match(/^\/api\/reviews\/([^/]+)(?:\/([a-z]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!m[2] && req.method === "GET") return reviewDetail(env, user, id);
    if (m[2] && req.method === "POST") return reviewAction(env, user, id, m[2], body, url.origin);
  }
  return fail("Not found.", 404);
}

/* ---------- Staff tallies ---------- */

async function staffApi(env: Env, user: User, req: Request, path: string, url: URL, body: any): Promise<Response> {
  const sc = scope(user, env, url.searchParams.get("rooftop") || body?.rooftop || null);
  try { await env.DB.prepare("SELECT 1 FROM staff LIMIT 1").first(); }
  catch { return json({ ready: false }); }

  // Tally for a range of calendar months
  if (path === "/api/staff/tally" && req.method === "GET") {
    const range = monthRange(url.searchParams.get("from") || "", url.searchParams.get("to") || "");
    if (!range) return fail("Pick a valid month range.");
    const role = url.searchParams.get("role");
    const mScope = sc.sql.replace(/\brooftop_key\b/g, "m.rooftop_key").replace(/\bis_sample\b/g, "r.is_sample");
    const roleSql = role && ["sales", "service", "other"].includes(role) ? " AND s.role = ?" : "";
    const base = `FROM mentions m JOIN reviews r ON r.id = m.review_id WHERE ${mScope} AND r.status != 'removed' AND m.review_time >= ? AND m.review_time < ?`;
    const args = [...sc.args, range[0], range[1]];
    const [people, unassigned, coverage] = await env.DB.batch([
      env.DB.prepare(`SELECT s.id, s.full_name, s.rooftop_key, s.role, s.active,
          COUNT(DISTINCT m.review_id) AS reviews,
          COUNT(DISTINCT CASE WHEN m.stars >= 4 THEN m.review_id END) AS positive,
          COUNT(DISTINCT CASE WHEN m.stars = 3 THEN m.review_id END) AS neutral,
          COUNT(DISTINCT CASE WHEN m.stars BETWEEN 1 AND 2 THEN m.review_id END) AS negative,
          ROUND(AVG(NULLIF(m.stars, 0)), 2) AS avg_stars
        ${base.replace("FROM mentions m", "FROM mentions m JOIN staff s ON s.id = m.staff_id")} AND m.match IN ('auto','manual')${roleSql}
        GROUP BY s.id ORDER BY reviews DESC, s.full_name`).bind(...args, ...(roleSql ? [role] : [])),
      env.DB.prepare(`SELECT m.rooftop_key, MIN(m.name_raw) AS name, m.match, COUNT(DISTINCT m.review_id) AS reviews
        ${base} AND m.match IN ('ambiguous','unmatched') GROUP BY m.rooftop_key, lower(m.name_raw), m.match ORDER BY reviews DESC`).bind(...args),
      env.DB.prepare(`SELECT COUNT(*) AS total, SUM(mentions_scanned_at IS NOT NULL) AS scanned FROM reviews
        WHERE ${sc.sql} AND create_time >= ? AND create_time < ?`).bind(...args),
    ]);
    return json({ ready: true, people: people.results, unassigned: unassigned.results, coverage: coverage.results[0], canTag: canTag(user) });
  }

  // Mentions waiting for someone to pick the right person
  if (path === "/api/staff/untagged" && req.method === "GET") {
    const range = monthRange(url.searchParams.get("from") || "", url.searchParams.get("to") || "");
    if (!range) return fail("Pick a valid month range.");
    const mScope = sc.sql.replace(/\brooftop_key\b/g, "m.rooftop_key").replace(/\bis_sample\b/g, "r.is_sample");
    const rows = (await env.DB.prepare(`SELECT m.id, m.review_id, m.rooftop_key, m.name_raw, m.role_hint, m.match, m.stars, m.review_time, substr(r.text, 1, 400) AS text
      FROM mentions m JOIN reviews r ON r.id = m.review_id
      WHERE ${mScope} AND m.review_time >= ? AND m.review_time < ? AND m.match IN ('ambiguous','unmatched')
      ORDER BY m.rooftop_key, lower(m.name_raw), m.review_time LIMIT 200`).bind(...sc.args, range[0], range[1]).all()).results;
    return json({ mentions: rows });
  }

  if (path === "/api/staff/roster" && req.method === "GET") {
    const staff = (await env.DB.prepare(`SELECT * FROM staff WHERE ${sc.sql.replace(/\bis_sample = 0( AND )?/, "") || "1=1"} ORDER BY rooftop_key, full_name`)
      .bind(...sc.args).all<Staff>()).results;
    return json({ staff, canTag: canTag(user) });
  }

  // Everything below changes data: admins and reply approvers only
  if (!canTag(user)) return fail("Only admins and reply approvers can change staff tags.", 403);

  if (path === "/api/staff/scan" && req.method === "POST") {
    const range = monthRange(String(body?.from || ""), String(body?.to || ""));
    if (!range) return fail("Pick a valid month range.");
    try {
      const r = await scanReviews(env, new Budget(10), { from: range[0], to: range[1], rooftops: user.rooftops, maxBatches: 4 });
      return json(r);
    } catch (e) { return fail((e as Error).message, 502); }
  }

  if (path === "/api/staff/roster" && req.method === "POST") {
    const op = String(body?.op || "");
    const findStaff = async (id: number) => {
      const s = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(id).first<Staff>();
      return s && canSee(user, s.rooftop_key) ? s : null;
    };
    const clean = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const role = (v: unknown) => (["sales", "service", "other"].includes(String(v)) ? String(v) : "sales");
    if (op === "add" || op === "bulk") {
      const rooftop = String(body?.rooftop || "");
      if (!canSee(user, rooftop) || ![...ROOFTOPS, DEFAULT_ROOFTOP].some((r) => r.key === rooftop)) return fail("Pick a store.");
      const people = op === "bulk" ? parseRosterLines(String(body?.text || ""), role(body?.role) as any)
        : [{ full_name: clean(body?.full_name, 80), role: role(body?.role), aliases: clean(body?.aliases, 200) }];
      const existing = new Set((await env.DB.prepare("SELECT full_name FROM staff WHERE rooftop_key = ?").bind(rooftop).all<{ full_name: string }>()).results.map((s) => norm(s.full_name)));
      const fresh = people.filter((p) => p.full_name && !existing.has(norm(p.full_name)));
      if (!fresh.length) return fail(people.length ? "Everyone listed is already on this store's roster." : "Enter a name.");
      await env.DB.batch(fresh.map((p) => env.DB.prepare("INSERT INTO staff (rooftop_key, full_name, role, aliases, created_at) VALUES (?,?,?,?,?)")
        .bind(rooftop, p.full_name, p.role, p.aliases, nowIso())));
      const changed = await rematch(env, rooftop);
      await logEvent(env, null, user.email, "staff_added", `${fresh.length} at ${rooftop}`);
      return json({ ok: true, added: fresh.length, skipped: people.length - fresh.length, rematched: changed });
    }
    if (op === "update" || op === "delete") {
      const s = await findStaff(Number(body?.id));
      if (!s) return fail("Staff member not found.", 404);
      if (op === "update") {
        await env.DB.prepare("UPDATE staff SET full_name = ?, role = ?, aliases = ?, active = ? WHERE id = ?")
          .bind(clean(body?.full_name, 80) || s.full_name, role(body?.role ?? s.role), clean(body?.aliases ?? s.aliases, 200), body?.active === false ? 0 : 1, s.id).run();
      } else {
        const used = await env.DB.prepare("SELECT 1 AS x FROM mentions WHERE staff_id = ? LIMIT 1").bind(s.id).first();
        if (used) await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(s.id).run(); // keep their history
        else await env.DB.prepare("DELETE FROM staff WHERE id = ?").bind(s.id).run();
      }
      return json({ ok: true, rematched: await rematch(env, s.rooftop_key) });
    }
    return fail("Unknown roster action.");
  }

  // Tag a mention: pick the person, mark "not an employee", add a missed name, or remove a manual tag
  if (path === "/api/staff/tag" && req.method === "POST") {
    const op = String(body?.op || "");
    if (op === "add") {
      const r = await getReview(env, String(body?.review_id || ""));
      if (!r || !canSee(user, r.rooftop_key)) return fail("Review not found.", 404);
      let s: Staff | null = null;
      const newName = String(body?.full_name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (newName) {
        // Tag someone who isn't on the roster yet: add them to this store, then tag
        const existing = (await env.DB.prepare("SELECT * FROM staff WHERE rooftop_key = ?").bind(r.rooftop_key).all<Staff>()).results
          .find((x) => norm(x.full_name) === norm(newName));
        if (existing) s = existing;
        else {
          const role = ["sales", "service", "other"].includes(String(body?.role)) ? String(body?.role) : "sales";
          await env.DB.prepare("INSERT INTO staff (rooftop_key, full_name, role, aliases, created_at) VALUES (?,?,?,?,?)")
            .bind(r.rooftop_key, newName, role, "", nowIso()).run();
          s = await env.DB.prepare("SELECT * FROM staff WHERE rooftop_key = ? AND full_name = ? ORDER BY id DESC LIMIT 1").bind(r.rooftop_key, newName).first<Staff>();
          await rematch(env, r.rooftop_key);
        }
      } else {
        s = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(Number(body?.staff_id)).first<Staff>();
      }
      if (!s || s.rooftop_key !== r.rooftop_key) return fail("Pick someone from this store's roster.");
      const already = await env.DB.prepare("SELECT 1 AS x FROM mentions WHERE review_id = ? AND staff_id = ? AND match IN ('auto','manual')").bind(r.id, s.id).first();
      if (already) return fail(`${s.full_name} is already tagged on this review.`);
      await env.DB.prepare(`INSERT INTO mentions (review_id, rooftop_key, review_time, stars, name_raw, role_hint, sentiment, staff_id, match, tagged_by, tagged_at)
        VALUES (?,?,?,?,?,?,?,?, 'manual', ?, ?)`).bind(r.id, r.rooftop_key, r.create_time, r.stars, s.full_name, s.role, "neutral", s.id, user.email, nowIso()).run();
      await logEvent(env, r.id, user.email, "staff_tagged", `Added ${s.full_name}`);
      return json({ ok: true });
    }
    const m = await env.DB.prepare("SELECT * FROM mentions WHERE id = ?").bind(Number(body?.mention_id)).first<any>();
    if (!m || !canSee(user, m.rooftop_key)) return fail("Tag not found.", 404);
    if (op === "assign") {
      const s = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(Number(body?.staff_id)).first<Staff>();
      if (!s || s.rooftop_key !== m.rooftop_key) return fail("Pick someone from this store's roster.");
      await env.DB.prepare("UPDATE mentions SET staff_id = ?, match = 'manual', tagged_by = ?, tagged_at = ? WHERE id = ?").bind(s.id, user.email, nowIso(), m.id).run();
      await logEvent(env, m.review_id, user.email, "staff_tagged", `"${m.name_raw}" is ${s.full_name}`);
    } else if (op === "ignore") {
      await env.DB.prepare("UPDATE mentions SET staff_id = NULL, match = 'ignored', tagged_by = ?, tagged_at = ? WHERE id = ?").bind(user.email, nowIso(), m.id).run();
      await logEvent(env, m.review_id, user.email, "staff_tagged", `"${m.name_raw}" is not an employee`);
    } else if (op === "remove") {
      await env.DB.prepare("DELETE FROM mentions WHERE id = ?").bind(m.id).run();
      await logEvent(env, m.review_id, user.email, "staff_tagged", `Removed ${m.name_raw}`);
    } else return fail("Unknown tag action.");
    return json({ ok: true });
  }

  return fail("Not found.", 404);
}
