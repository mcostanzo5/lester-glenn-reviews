import type { Env } from "./types";
import { iso } from "./types";
import { Budget, unlimited } from "./budget";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const LOCATIONS_URL = (a: string) => `https://mybusinessbusinessinformation.googleapis.com/v1/${a}/locations`;
const REVIEWS_URL = (a: string, l: string) => `https://mybusiness.googleapis.com/v4/${a}/${l}/reviews`;
const REPLY_URL = (r: string) => `https://mybusiness.googleapis.com/v4/${r}/reply`;
const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export class GBPError extends Error {}

export interface GReview {
  id: string;
  stars: number;
  text: string;
  create_time: string;
  update_time: string;
  reply_text: string | null;
  reply_time: string | null;
}

/** Only what the dashboard needs. The reviewer's name is deliberately dropped. */
function normalize(raw: any): GReview {
  return {
    id: raw.name,
    stars: STARS[raw.starRating] ?? 0,
    text: (raw.comment || "").trim(),
    create_time: iso(raw.createTime),
    update_time: iso(raw.updateTime || raw.createTime),
    reply_text: raw.reviewReply?.comment ?? null,
    reply_time: raw.reviewReply ? iso(raw.reviewReply.updateTime) : null,
  };
}

export class GBPClient {
  private token = "";
  private expires = 0;
  constructor(private env: Env, private budget: Budget = unlimited()) {
    if (!env.GBP_CLIENT_ID || !env.GBP_CLIENT_SECRET || !env.GBP_REFRESH_TOKEN) {
      throw new GBPError("Google credentials are missing. Set GBP_CLIENT_ID, GBP_CLIENT_SECRET and GBP_REFRESH_TOKEN as Worker secrets.");
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.expires - 60_000) return this.token;
    this.budget.take();
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.GBP_CLIENT_ID!,
        client_secret: this.env.GBP_CLIENT_SECRET!,
        refresh_token: this.env.GBP_REFRESH_TOKEN!,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new GBPError(`Google sign-in failed (${res.status}). If it says invalid_grant, generate a new refresh token. ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    this.token = data.access_token;
    this.expires = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token;
  }

  private async call(method: string, url: string, body?: unknown): Promise<any> {
    let delay = 1000;
    for (let attempt = 0; attempt < 4; attempt++) {
      const auth = `Bearer ${await this.accessToken()}`;
      this.budget.take();
      const res = await fetch(url, {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 3 && this.budget.has(1)) { await new Promise((r) => setTimeout(r, delay)); delay *= 2; continue; }
        const hint = res.status === 429 ? " A steady 429 usually means Google has not approved API access yet." : "";
        throw new GBPError(`${method} failed (${res.status}).${hint}`);
      }
      if (!res.ok) throw new GBPError(`${method} ${url} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
  }

  private async all(url: string, key: string, params: Record<string, string> = {}): Promise<any[]> {
    const out: any[] = [];
    let token = "";
    do {
      const q = new URLSearchParams(params);
      if (token) q.set("pageToken", token);
      const data = await this.call("GET", `${url}?${q}`);
      out.push(...(data[key] || []));
      token = data.nextPageToken || "";
    } while (token);
    return out;
  }

  listAccounts() { return this.all(ACCOUNTS_URL, "accounts"); }
  listLocations(account: string) { return this.all(LOCATIONS_URL(account), "locations", { readMask: "name,title", pageSize: "100" }); }

  /** One page of reviews, newest first. */
  async reviewPage(account: string, location: string, pageToken?: string): Promise<{ reviews: GReview[]; next: string | null }> {
    const q = new URLSearchParams({ pageSize: "50", orderBy: "updateTime desc" });
    if (pageToken) q.set("pageToken", pageToken);
    const data = await this.call("GET", `${REVIEWS_URL(account, location)}?${q}`);
    return { reviews: (data.reviews || []).map(normalize), next: data.nextPageToken || null };
  }

  async postReply(reviewId: string, text: string): Promise<void> {
    if (!reviewId.startsWith("accounts/")) throw new GBPError("Refusing to post: not a real Google review.");
    await this.call("PUT", REPLY_URL(reviewId), { comment: text });
  }
}
