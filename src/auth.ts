import type { Env, User } from "./types";

import { sessionEmail } from "./msauth";

// Identifies the signed-in person from their Microsoft session, then looks up their role.

export async function identify(req: Request, env: Env): Promise<{ user?: User; error?: string; status?: number }> {
  let email: string | null = null;
  if (env.DEV_AUTH_EMAIL && new URL(req.url).hostname === "localhost") {
    email = env.DEV_AUTH_EMAIL.toLowerCase();
  } else {
    email = await sessionEmail(req, env);
    if (!email) return { error: "Your sign-in expired. Refresh the page to sign in again.", status: 401 };
  }

  const admins = (env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (admins.includes(email)) return { user: { email, role: "admin", rooftops: "*" } };

  const row = await env.DB.prepare("SELECT role, rooftops FROM users WHERE email = ?").bind(email).first<{ role: User["role"]; rooftops: string }>();
  if (!row) return { error: `${email} doesn't have access yet. Ask an admin to add you in Settings.`, status: 403 };
  return { user: { email, role: row.role, rooftops: row.rooftops === "*" ? "*" : row.rooftops.split(",").filter(Boolean) } };
}

export function canSee(user: User, rooftopKey: string): boolean {
  return user.rooftops === "*" || user.rooftops.includes(rooftopKey);
}

export function canAct(user: User, rooftopKey: string): boolean {
  return user.role !== "viewer" && canSee(user, rooftopKey);
}
