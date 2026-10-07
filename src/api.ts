import type { Env, ReviewRow, User } from "./types";
import { mode, nowIso } from "./types";
import { canAct, canSee } from "./auth";
import { ROOFTOPS, DEFAULT_ROOFTOP } from "./rooftops";
import { GBPClient } from "./gbp";
import { cleanReply } from "./drafter";
import { draftAndRoute, logEvent, postReply, runAgent } from "./agent";
import { clearSamples, loadSamples } from "./samples";

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
  return json({
    email: user.email, role: user.role, mode: mode(env),
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
  else if (status === "open") where.push(`status IN ${OPEN_SQL}`);
  else if (status === "answered") where.push(`status IN ${ANSWERED_SQL}`);
  else if (status) { where.push("status = ?"); args.push(status); }
  const stars = url.searchParams.get("stars");
  if (stars === "low") where.push("stars <= 3");
  else if (stars === "high") where.push("stars >= 4");
  const q = (url.searchParams.get("q") || "").trim();
  if (q) { where.push("(text LIKE ? OR draft LIKE ? OR reply_text LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const page = Math.max(0, parseInt(url.searchParams.get("page") || "0", 10) || 0);
  const order = view === "inbox" ? "CASE status WHEN 'pending' THEN 0 WHEN 'error' THEN 1 WHEN 'new' THEN 2 ELSE 3 END, create_time ASC" : "create_time DESC";
  const rows = (await env.DB.prepare(`SELECT * FROM reviews WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 51 OFFSET ?`)
    .bind(...args, page * 50).all<ReviewRow>()).results;
  return json({ reviews: rows.slice(0, 50), more: rows.length > 50, page });
}

async function getReview(env: Env, id: string): Promise<ReviewRow | null> {
  return env.DB.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first<ReviewRow>();
}

async function reviewDetail(env: Env, user: User, id: string) {
  const r = await getReview(env, id);
  if (!r || !canSee(user, r.rooftop_key)) return fail("Review not found.", 404);
  const events = (await env.DB.prepare("SELECT actor, action, detail, at FROM events WHERE review_id = ? ORDER BY id DESC LIMIT 50").bind(id).all()).results;
  return json({ review: r, events });
}

async function reviewAction(env: Env, user: User, id: string, action: string, body: any) {
  const r = await getReview(env, id);
  if (!r || !canSee(user, r.rooftop_key)) return fail("Review not found.", 404);
  if (!canAct(user, r.rooftop_key)) return fail("You have view-only access to this store.", 403);
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
  if (path === "/api/reviews" && req.method === "GET") return listReviews(env, user, url);
  if (path === "/api/stats") return stats(env, user, url);
  if (path.startsWith("/api/admin/")) return admin(env, user, req, path, url, body);
  const m = path.match(/^\/api\/reviews\/([^/]+)(?:\/([a-z]+))?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!m[2] && req.method === "GET") return reviewDetail(env, user, id);
    if (m[2] && req.method === "POST") return reviewAction(env, user, id, m[2], body);
  }
  return fail("Not found.", 404);
}
