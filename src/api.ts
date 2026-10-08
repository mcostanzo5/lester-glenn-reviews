import type { Env, ReviewRow, User } from "./types";
import { mode, nowIso } from "./types";
import { canAct, canSee, wasRecipient } from "./auth";
import { ROOFTOPS, DEFAULT_ROOFTOP } from "./rooftops";
import { GBPClient } from "./gbp";
import { cleanReply } from "./drafter";
import { draftAndRoute, logEvent, postReply, runAgent } from "./agent";
import { clearSamples, loadSamples } from "./samples";
import { availableReplies, learnGuidelines, MIN_REPLIES } from "./learn";
import { clearGuidelinesCache, currentGuidelines } from "./guidelines";
import { CONCERN_LABEL, FIELDS_FOR, TEAMS_FOR, buildEmail, lastEscalation, getTeams, parseEscalation, resolveEscalation, saveTeams, sendEscalation, type Team } from "./escalate";
import { Budget } from "./budget";
import { canTag, monthRange, norm, parseRosterLines, rematch, scanReviews, type Staff } from "./staff";
import { allowedDomains, canSendAs, checkAddresses, mailConfigured, MailError } from "./mail";

const ANSWERED_SQL = "('auto_posted','approved_posted','replied_external')";
const OPEN_SQL = "('new','pending','ready','approved','error','old_unanswered')";
const INBOX_SQL = "('new','pending','error')";

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

async function me(env: Env, user: User) {
  const s = scope(user, env);
  const counts = (await env.DB.prepare(
    `SELECT rooftop_key, COUNT(*) n FROM reviews WHERE ${s.sql} AND status IN ${INBOX_SQL} GROUP BY rooftop_key`
  ).bind(...s.args).all<{ rooftop_key: string; n: number }>()).results;
  const map = Object.fromEntries(counts.map((c) => [c.rooftop_key, c.n]));
  let escalations: number | null = null;
  try {
    escalations = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE ${s.sql} AND escalation_open > 0`)
      .bind(...s.args).first<{ n: number }>())?.n ?? 0;
  } catch { /* escalation columns not added yet */ }
  return json({
    email: user.email, name: user.name, role: user.role, canReply: user.canReply, mode: mode(env), escalations,
    approvers: (env.REPLY_APPROVERS || "").split(",").map((e) => e.trim()).filter(Boolean),
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
  if (view === "inbox") where.push(`status IN ${INBOX_SQL}`);
  else if (view === "escalations") where.push("escalation_open > 0");
  else if (status === "open") where.push(`status IN ${OPEN_SQL}`);
  else if (status === "answered") where.push(`status IN ${ANSWERED_SQL}`);
  else if (status) { where.push("status = ?"); args.push(status); }
  const stars = url.searchParams.get("stars");
  if (stars === "low") where.push("stars <= 3");
  else if (stars === "high") where.push("stars >= 4");
  const staffId = parseInt(url.searchParams.get("staff") || "", 10);
  if (staffId) { where.push("id IN (SELECT review_id FROM mentions WHERE staff_id = ? AND match IN ('auto','manual'))"); args.push(staffId); }
  const range = monthRange(url.searchParams.get("from") || "", url.searchParams.get("to") || "");
  if (range) { where.push("create_time >= ? AND create_time < ?"); args.push(range[0], range[1]); }
  const q = (url.searchParams.get("q") || "").trim();
  if (q) { where.push("(text LIKE ? OR draft LIKE ? OR reply_text LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const page = Math.max(0, parseInt(url.searchParams.get("page") || "0", 10) || 0);
  const order = view === "inbox" ? "CASE status WHEN 'pending' THEN 0 WHEN 'error' THEN 1 WHEN 'new' THEN 2 ELSE 3 END, create_time ASC"
    : view === "escalations" ? "escalation_first_at ASC" // longest-waiting first
    : "create_time DESC";
  const rows = (await env.DB.prepare(`SELECT * FROM reviews WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 51 OFFSET ?`)
    .bind(...args, page * 50).all<ReviewRow>()).results;
  for (const row of rows) delete (row as any).escalation_details;
  return json({ reviews: rows.slice(0, 50), more: rows.length > 50, page });
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
  if (user.role === "link") { r.draft = null; r.route_reason = null; r.risk_flags = null; }
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
  return json({ review: r, events, escalation, staff });
}

async function reviewAction(env: Env, user: User, id: string, action: string, body: any, origin: string) {
  const r = await getReview(env, id);
  if (!r || !canSee(user, r.rooftop_key)) return fail("Review not found.", 404);
  const replyActions = ["save", "approve", "dismiss", "reopen", "redraft"];
  if (replyActions.includes(action) && !user.canReply) {
    return fail(`Only ${(env.REPLY_APPROVERS || "the reply approvers").split(",").join(" and ")} can change replies.`, 403);
  }
  if (!replyActions.includes(action) && !canAct(user, r.rooftop_key)) return fail("You have view-only access to this store.", 403);
  const reply = typeof body?.reply === "string" ? cleanReply(body.reply) : "";

  if (action === "save") {
    if (!reply) return fail("Write a reply before saving.");
    await env.DB.prepare("UPDATE reviews SET draft = ? WHERE id = ?").bind(reply, id).run();
    await logEvent(env, id, user.email, "edited");
  } else if (action === "approve") {
    if (!reply) return fail("Write a reply before approving.");
    if (["auto_posted", "approved_posted", "replied_external"].includes(r.status)) return fail("This review already has a reply.");
    await env.DB.prepare("UPDATE reviews SET draft=?, decided_by=?, decided_at=? WHERE id=?").bind(reply, user.email, nowIso(), id).run();
    if (mode(env) === "live" && !r.is_sample) {
      try { await postReply(env, new GBPClient(env), r, reply, user.email, "manager"); }
      catch (e) { return fail(`Google didn't accept the reply: ${(e as Error).message}`, 502); }
    } else {
      await env.DB.prepare("UPDATE reviews SET status='approved' WHERE id=?").bind(id).run();
      await logEvent(env, id, user.email, "approved", "Will post when the agent is live");
    }
  } else if (action === "dismiss") {
    await env.DB.prepare("UPDATE reviews SET status='dismissed', decided_by=?, decided_at=? WHERE id=?").bind(user.email, nowIso(), id).run();
    await logEvent(env, id, user.email, "dismissed", String(body?.note || "").slice(0, 500));
  } else if (action === "reopen") {
    await env.DB.prepare("UPDATE reviews SET status='pending' WHERE id=?").bind(id).run();
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
  const where = days > 0 ? `${s.sql} AND create_time >= ?` : s.sql;
  const args = days > 0 ? [...s.args, new Date(Date.now() - days * 86400_000).toISOString()] : s.args;
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
    const base = `FROM mentions m JOIN reviews r ON r.id = m.review_id WHERE ${mScope} AND m.review_time >= ? AND m.review_time < ?`;
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
      const s = await env.DB.prepare("SELECT * FROM staff WHERE id = ?").bind(Number(body?.staff_id)).first<Staff>();
      if (!r || !canSee(user, r.rooftop_key)) return fail("Review not found.", 404);
      if (!s || s.rooftop_key !== r.rooftop_key) return fail("Pick someone from this store's roster.");
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
