// Counts outside calls (Google and Claude) so a run never goes over the
// Cloudflare per-run limit. The free plan allows 50; the default budget of 45
// leaves headroom. On Workers Paid, raise EXTERNAL_REQUEST_BUDGET to 900.

export class BudgetExhausted extends Error {
  constructor() { super("Request budget for this run is used up; remaining work continues next run."); }
}

export class Budget {
  constructor(public left: number) {}
  has(n = 1): boolean { return this.left >= n; }
  take(n = 1): void {
    if (this.left < n) throw new BudgetExhausted();
    this.left -= n;
  }
}

/** Dashboard actions (approve, redraft) are their own small requests. */
export const unlimited = () => new Budget(Number.POSITIVE_INFINITY);
