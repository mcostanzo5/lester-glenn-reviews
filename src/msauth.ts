import type { Env } from "./types";

// Microsoft 365 sign-in, handled entirely by the Worker.
// Flow: /auth/login sends the person to Microsoft, Microsoft sends them back to
// /auth/callback, the Worker checks Microsoft's signed ID token, then sets a
// signed session cookie good for 12 hours. Only accounts in your own Microsoft
// tenant can sign in.

const LOGIN_BASE = "https://login.microsoftonline.com";
const SESSION_COOKIE = "__Host-lg_session";
const OAUTH_COOKIE = "__Host-lg_oauth";
const SESSION_HOURS = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export function msConfigured(env: Env): boolean {
  return !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
}

/** Cookies are signed with a key derived from the client secret (or SESSION_SECRET if set). */
async function signingKey(env: Env): Promise<CryptoKey> {
  const material = env.SESSION_SECRET || `lg-session:${env.MS_CLIENT_SECRET}`;
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(material));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function seal(env: Env, data: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(data)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function unseal<T extends { x: number }>(env: Env, value: string | undefined): Promise<T | null> {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await signingKey(env), fromB64url(sig), enc.encode(body));
  if (!ok) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(body))) as T;
    return data.x > Date.now() ? data : null;
  } catch { return null; }
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}

function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function safeReturn(path: string | null): string {
  return path && path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/auth/") ? path : "/";
}

function redirectUri(req: Request): string {
  return `${new URL(req.url).origin}/auth/callback`;
}

/** Signed-in email from the session cookie, or null. */
export async function sessionEmail(req: Request, env: Env): Promise<string | null> {
  const s = await unseal<{ e: string; x: number }>(env, getCookie(req, SESSION_COOKIE));
  return s?.e ?? null;
}

export async function login(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  const sealed = await seal(env, { s: state, n: nonce, v: verifier, r: safeReturn(url.searchParams.get("returnTo")), x: Date.now() + 10 * 60_000 });
  const auth = new URL(`${LOGIN_BASE}/${env.MS_TENANT_ID}/oauth2/v2.0/authorize`);
  auth.search = new URLSearchParams({
    client_id: env.MS_CLIENT_ID!,
    response_type: "code",
    redirect_uri: redirectUri(req),
    response_mode: "query",
    scope: "openid profile email",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, { status: 302, headers: { location: auth.toString(), "set-cookie": cookie(OAUTH_COOKIE, sealed, 600), "cache-control": "no-store" } });
}

let jwks: { keys: any[]; at: number } | null = null;
async function msKeys(env: Env, refresh = false): Promise<any[]> {
  if (!refresh && jwks && Date.now() - jwks.at < 6 * 3600_000) return jwks.keys;
  const res = await fetch(`${LOGIN_BASE}/${env.MS_TENANT_ID}/discovery/v2.0/keys`);
  if (!res.ok) throw new Error("Could not load Microsoft signing keys");
  jwks = { keys: ((await res.json()) as any).keys || [], at: Date.now() };
  return jwks.keys;
}

/** Checks the ID token's signature and claims. Returns the email or a reason it failed. */
async function verifyIdToken(env: Env, token: string, nonce: string): Promise<{ email?: string; error?: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) return { error: "malformed token" };
  const header = JSON.parse(dec.decode(fromB64url(parts[0])));
  const claims = JSON.parse(dec.decode(fromB64url(parts[1])));
  if (header.alg !== "RS256") return { error: "unexpected token type" };
  let jwk = (await msKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await msKeys(env, true)).find((k) => k.kid === header.kid); // Microsoft rotates keys
  if (!jwk) return { error: "unknown signing key" };
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return { error: "bad signature" };
  const now = Date.now() / 1000;
  if (claims.aud !== env.MS_CLIENT_ID) return { error: "token was issued for a different app" };
  if (claims.tid !== env.MS_TENANT_ID) return { error: "account is not in the Lester Glenn Microsoft tenant" };
  if (claims.iss !== `${LOGIN_BASE}/${env.MS_TENANT_ID}/v2.0`) return { error: "unexpected issuer" };
  if (typeof claims.exp !== "number" || claims.exp < now - 60) return { error: "token expired" };
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) return { error: "token not yet valid" };
  if (claims.nonce !== nonce) return { error: "sign-in attempt did not match" };
  const email = String(claims.email || claims.preferred_username || "").toLowerCase();
  if (!email.includes("@")) return { error: "no email on the Microsoft account" };
  return { email };
}

export async function callback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const pending = await unseal<{ s: string; n: string; v: string; r: string; x: number }>(env, getCookie(req, OAUTH_COOKIE));
  const clearOauth = cookie(OAUTH_COOKIE, "", 0);
  if (url.searchParams.get("error")) {
    return page("Sign-in was cancelled", `Microsoft said: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`, clearOauth);
  }
  if (!pending || pending.s !== url.searchParams.get("state")) {
    return page("Sign-in expired", "That sign-in link is old or was opened in a different browser. Please try again.", clearOauth);
  }
  const res = await fetch(`${LOGIN_BASE}/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID!,
      client_secret: env.MS_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code: url.searchParams.get("code") || "",
      redirect_uri: redirectUri(req),
      code_verifier: pending.v,
      scope: "openid profile email",
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    console.error("token exchange failed", res.status, data.error, data.error_description);
    return page("Sign-in didn't finish", "Microsoft didn't complete the sign-in. If this keeps happening, check that the client secret in Cloudflare hasn't expired.", clearOauth);
  }
  const result = await verifyIdToken(env, data.id_token, pending.n);
  if (!result.email) {
    console.error("id token rejected:", result.error);
    return page("Sign-in not accepted", `The sign-in couldn't be verified (${result.error}).`, clearOauth);
  }
  const session = await seal(env, { e: result.email, x: Date.now() + SESSION_HOURS * 3600_000 });
  const headers = new Headers({ location: pending.r || "/", "cache-control": "no-store" });
  headers.append("set-cookie", clearOauth);
  headers.append("set-cookie", cookie(SESSION_COOKIE, session, SESSION_HOURS * 3600));
  return new Response(null, { status: 302, headers });
}

export function logout(): Response {
  return page("You're signed out", "You've been signed out of Lester Glenn Reviews.", cookie(SESSION_COOKIE, "", 0));
}

/** Small standalone page for sign-in messages. */
export function page(title: string, message: string, setCookie?: string, status = 200): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>body{font:16px/1.5 "Segoe UI",system-ui,sans-serif;background:#f3f5f8;color:#17212b;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border:1px solid #dbe1e8;border-radius:10px;padding:32px;max-width:420px;margin:20px;text-align:center}
h1{font-size:22px;margin:0 0 8px}a{display:inline-block;margin-top:18px;background:#0772bc;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#0f151b;color:#e6ebf0}main{background:#172029;border-color:#2a3642}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/auth/login">Sign in with Microsoft</a></main></body></html>`;
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(html, { status, headers });
}
