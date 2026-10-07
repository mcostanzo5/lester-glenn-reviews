# Lester Glenn Reviews

One Cloudflare Worker that runs the review agent 4 times a day, stores every Google
review in a database, and serves the dashboard behind Microsoft sign-in.

**Important:** this replaces the GitHub Actions agent. Before you switch this one
to `shadow` or `live`, disable the old workflow (GitHub repo > Actions > Review
Agent > the three-dot menu > Disable workflow) so the two never reply to the
same review.

## What's inside

| Path | What it does |
|---|---|
| `src/agent.ts` | Scheduled run: sync reviews from Google, draft with Claude, route, post |
| `src/router.ts` | Rules for what can auto-post, including the keyword list that always goes to a manager |
| `src/guidelines.ts` | Voice and rules Claude follows. Add your best real replies as examples here |
| `src/rooftops.ts` | Store names, sign-offs, contacts, and phone numbers (blank phone = no phone in replies) |
| `src/api.ts` | Dashboard API and statistics |
| `src/auth.ts` | Verifies the Microsoft sign-in from Cloudflare Access and applies roles |
| `public/` | The dashboard itself |
| `migrations/` | Database tables |

## One-time setup

You need Node.js installed (the LTS version from nodejs.org). Open a terminal in
this folder for every command below.

**1. Install and sign in to Cloudflare**
```
npm install
npx wrangler login
```

**2. Create the database**
```
npx wrangler d1 create lester-glenn-reviews
```
Copy the `database_id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_DATABASE_ID`. Then create the tables:
```
npm run db:migrate:remote
```

**3. Add secrets** (each command asks you to paste the value; it's never shown again)
```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GBP_CLIENT_ID
npx wrangler secret put GBP_CLIENT_SECRET
npx wrangler secret put GBP_REFRESH_TOKEN
```
Use the new Google values from after you rotated them. The Google ones can wait
until API access is approved; dry run only needs the Anthropic key.

**4. Deploy**
```
npm run deploy
```
It prints your site address, something like
`https://lester-glenn-reviews.<your-subdomain>.workers.dev`. The dashboard will
say sign-in isn't configured yet. That's expected until step 5 is done.

**5. Turn on Microsoft sign-in (Cloudflare Access)**
1. In the Cloudflare dashboard, open **Zero Trust**. Pick a team name when asked;
   your team domain becomes `<team>.cloudflareaccess.com`.
2. Go to **Settings > Authentication > Login methods > Add new > Azure AD** and
   follow Cloudflare's Entra ID guide. This step needs your Microsoft 365 admin to
   create the app registration and grant admin consent.
3. Go to **Access > Applications > Add an application > Self-hosted**. Use your
   `workers.dev` address (or a custom domain like `reviews.lesterglenn.com`) as
   the application domain, and pick Azure AD as the login method.
4. Add a policy: **Allow**, include **Emails ending in** `@lesterglenn.com`.
5. Open the application's **Overview** and copy the **Application Audience (AUD) Tag**.
6. In `wrangler.toml`, set `ACCESS_TEAM_DOMAIN` to `<team>.cloudflareaccess.com`
   and `ACCESS_AUD` to that tag, then run `npm run deploy` again.

**6. Try it**
Open the site and sign in with Microsoft. Go to **Settings**, click **Load sample
data**, then **Run agent now**. The inbox fills with drafted sample reviews and
Statistics shows six months of sample history.

## Adding people

In **Settings**, add each person's Microsoft email with a role:
- **Manager:** reviews, edits, approves, and dismisses replies for their stores
- **View only:** sees reviews and statistics, can't change anything
- **Admin:** everything, including settings and agent runs

Check the stores a person should see, or leave them all unchecked for every
store. Anyone in `ADMIN_EMAILS` in `wrangler.toml` is always an admin.

## Going live

1. After Google approves API access, set `AGENT_MODE = "shadow"` in
   `wrangler.toml`, run `npm run deploy`, and clear the sample data in Settings.
   The agent now reads real reviews 4 times a day and imports your full review history
   for statistics, a few pages per store per run, but posts nothing.
2. Review drafts for a week or two. Tune `src/guidelines.ts` and `src/router.ts`
   until you trust them.
3. Set `AGENT_MODE = "live"` and deploy. Safe replies post on their own, and
   approving a reply in the dashboard posts it immediately. Replies approved
   during shadow mode post on the first live run.

**Free plan vs. Workers Paid.** The free plan allows 50 outside calls (Google and
Claude) per run. The agent budgets for this: each run checks every store for new
reviews first, then drafts, then posts, and spends anything left on importing
older history. If a run hits the budget, the rest simply rolls to the next run.
A typical run uses about 14 calls to check all 11 stores, leaving room for
around 15 new reviews per run (60 a day) to be drafted and posted.

Two reasons you might still upgrade to Workers Paid ($5 a month): the free plan
also caps CPU time at 10 ms per run, which heavy history-import runs can brush
against (check the Worker's Metrics page for "Exceeded CPU" errors), and on paid
you can set `EXTERNAL_REQUEST_BUDGET = "900"` so history imports in one run.

## Modes

Scheduled runs happen at 8am, 12pm, 4pm, and 8pm Eastern all year, including
across daylight saving changes. To change the times, edit `RUN_HOURS_ET` and
`crons` in `wrangler.toml` (the comment there explains how) and deploy.
Admins can also click **Run agent now** in Settings at any time.


| Mode | Reads Google | Posts | Scheduled runs |
|---|---|---|---|
| `dry_run` | No, sample data only | Never | Paused (use Run agent now) |
| `shadow` | Yes | Never | 4 times a day |
| `live` | Yes | Safe replies and approved replies | 4 times a day |

## Testing on your own computer

```
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```
Open `http://localhost:8787`. On localhost only, `.dev.vars` signs you in without
Microsoft. Never deploy `.dev.vars`.

## Privacy and safety

- Reviewer names are dropped the moment a review is read and are never stored,
  sent to Claude, or shown in the dashboard.
- A review that already has a reply in Google is never replied to again.
- Nothing auto-posts unless the keyword check and Claude's risk rating both clear it.
- Every draft, edit, approval, dismissal, and post is recorded in the review's history.
