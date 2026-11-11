import type { Env, User } from "./types";

import { sessionUser } from "./msauth";

// Identifies the signed-in person from their Microsoft session, then looks up their role.

export async function identify(req: Request, env: Env): Promise<{ user?: User; error?: string; status?: number }> {
  let email: string | null = null;
  let name: string | undefined;
  if (env.DEV_AUTH_EMAIL && new URL(req.url).hostname === "localhost") {
    email = env.DEV_AUTH_EMAIL.toLowerCase();
  } else {
    const s = await sessionUser(req, env);
    email = s?.email ?? null;
    name = s?.name;
    if (!email) return { error: "Your sign-in expired. Refresh the page to sign in again.", status: 401 };
  }

  const list = (v?: string) => (v || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const canReply = list(env.REPLY_APPROVERS).includes(email);
  if (list(env.ADMIN_EMAILS).includes(email)) return { user: { email, name, role: "admin", rooftops: "*", canReply } };

  const row = await env.DB.prepare("SELECT role, rooftops FROM users WHERE email = ?").bind(email).first<{ role: User["role"]; rooftops: string }>();
  if (row) return { user: { email, name, role: row.role, rooftops: row.rooftops === "*" ? "*" : row.rooftops.split(",").filter(Boolean), canReply } };
  // Approvers always get in, across every store
  if (canReply) return { user: { email, name, role: "manager", rooftops: "*", canReply } };
  // Anyone else in the company: read-only access to reviews escalated to them
  return { user: { email, name, role: "link", rooftops: [], canReply: false } };
}

/** Was this person sent an escalation about this review? Lets "link" users open it. */
export async function wasRecipient(env: Env, email: string, reviewId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS ok FROM escalations WHERE review_id = ? AND (',' || recipients || ',') LIKE ? LIMIT 1"
    ).bind(reviewId, `%,${email},%`).first();
    return !!row;
  } catch { return false; }
}

export function canSee(user: User, rooftopKey: string): boolean {
  return user.rooftops === "*" || user.rooftops.includes(rooftopKey);
}

/** Escalate and resolve. Managers and admins for that store. */
export function canAct(user: User, rooftopKey: string): boolean {
  return (user.role === "admin" || user.role === "manager") && canSee(user, rooftopKey);
}
