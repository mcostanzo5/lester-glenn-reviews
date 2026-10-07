export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AGENT_MODE: string;
  MS_TENANT_ID: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  ADMIN_EMAILS: string;
  MAX_AGE_DAYS: string;
  MAX_DRAFTS_PER_RUN: string;
  AUTO_POST_MIN_STARS: string;
  CLAUDE_MODEL: string;
  EXTERNAL_REQUEST_BUDGET: string;
  BACKFILL_PAGES_PER_RUN: string;
  RUN_HOURS_ET: string;
  GBP_CLIENT_ID?: string;
  GBP_CLIENT_SECRET?: string;
  GBP_REFRESH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  // Local development only (.dev.vars). Never set in production.
  DEV_AUTH_EMAIL?: string;
}

export type Mode = "dry_run" | "shadow" | "live";

export type Status =
  | "new"              // waiting for a draft
  | "pending"          // needs a manager
  | "ready"            // cleared to auto-post, but agent is not live
  | "approved"         // manager approved, posts when agent is live
  | "auto_posted"
  | "approved_posted"
  | "replied_external" // someone replied directly in Google
  | "dismissed"        // manager chose not to reply here
  | "old_unanswered"   // older than the drafting window, no reply
  | "error";

export const ANSWERED: Status[] = ["auto_posted", "approved_posted", "replied_external"];

export interface ReviewRow {
  id: string;
  location_name: string | null;
  rooftop_key: string;
  location_title: string | null;
  stars: number;
  text: string;
  create_time: string;
  update_time: string;
  status: Status;
  department: string | null;
  sentiment: string | null;
  risk_level: string | null;
  risk_flags: string | null;
  route_reason: string | null;
  draft: string | null;
  reply_text: string | null;
  reply_time: string | null;
  reply_source: string | null;
  decided_by: string | null;
  decided_at: string | null;
  is_sample: number;
}

export interface User {
  email: string;
  role: "admin" | "manager" | "viewer";
  rooftops: string[] | "*";
}

export function mode(env: Env): Mode {
  const m = (env.AGENT_MODE || "dry_run").trim().toLowerCase();
  return m === "live" || m === "shadow" ? m : "dry_run";
}

export function num(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalize any timestamp to millisecond ISO so SQLite date math is consistent. */
export function iso(value: string | undefined | null): string {
  if (!value) return nowIso();
  const d = new Date(value);
  return isNaN(d.getTime()) ? nowIso() : d.toISOString();
}
