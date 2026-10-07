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
| `src/guidelines.ts` | Built-in starter guidelines, plus the safety rules that always apply |
| `src/learn.ts` | Writes new guidelines from your team's real replies (Settings > Reply guidelines) |
| `src/rooftops.ts` | Store names, sign-offs, contacts, and phone numbers (blank phone = no phone in replies) |
| `src/api.ts` | Dashboard API and statistics |
| `src/escalate.ts` | Escalation emails to store teams: form rules, email template, counters |
| `src/mail.ts` | Sends email through Microsoft 365 from the signed-in person's mailbox |
| `src/msauth.ts` | Microsoft 365 sign-in: sends people to Microsoft and verifies who they are |
| `src/auth.ts` | Applies roles (admin, manager, view only) to the signed-in person |
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

**5. Turn on Microsoft 365 sign-in**

The Worker signs people in with Microsoft directly. Only accounts in your own
Microsoft tenant can get in. Someone with Entra admin rights does this part:

1. In the Microsoft Entra admin center, go to **App registrations > New registration**.
   - Name: `Lester Glenn Reviews`
   - Supported account types: **Accounts in this organizational directory only** (single tenant)
   - Redirect URI: platform **Web**, address `https://<your workers.dev address>/auth/callback`
2. On the app's **Overview** page, copy the **Application (client) ID** and the
   **Directory (tenant) ID**.
3. Under **Certificates & secrets > New client secret**, pick an expiry (24 months
   is the longest), and copy the secret's **Value** right away. It's only shown once.
   Put a reminder on the calendar to renew it before it expires.
4. Under **API permissions**, make sure Microsoft Graph has the delegated
   permissions `openid`, `profile`, `email`, and `User.Read`, then click
   **Grant admin consent**.

Then connect it:

5. In `wrangler.toml`, set `MS_TENANT_ID` and `MS_CLIENT_ID` to the two IDs and deploy.
6. Add the secret: `npx wrangler secret put MS_CLIENT_SECRET` (or in the Cloudflare
   dashboard: Worker > Settings > Variables and Secrets > Add > Secret).

**6. Try it**
Open the site. You're sent to Microsoft to sign in, then back to the dashboard. Go to **Settings**, click **Load sample
data**, then **Run agent now**. The inbox fills with drafted sample reviews and
Statistics shows six months of sample history.

## Adding people

In **Settings**, add each person's Microsoft email with a role:
- **Manager:** reviews, edits, approves, and dismisses replies for their stores
- **View only:** sees reviews and statistics, can't change anything
- **Admin:** everything, including settings and agent runs

Check the stores a person should see, or leave them all unchecked for every
store. Anyone in `ADMIN_EMAILS` in `wrangler.toml` is always an admin. Anyone in
your Microsoft tenant can reach the sign-in page, but only people added here (or
listed in `ADMIN_EMAILS`) can see anything after signing in.

## Reply guidelines

Claude follows the guidelines shown in **Settings > Reply guidelines**. To match
how your team actually writes, click **Learn from our Google replies** (available
once at least 20 replies written by your team have synced) or **Paste replies
instead**. Claude reads them and writes a new set of guidelines into the editor.
Nothing is saved until you review it and click **Save guidelines**. The agent's
own replies are never used for learning, and the privacy and safety rules are
always added on top of whatever is saved.

One-time setup: run the SQL in `migrations/0002_settings.sql` in the D1 console
before using this panel.

## Escalations

Anyone with manager or admin access can open a review and click **Escalate**
(or **Follow up with the team** if it's already been escalated). They pick
Sales, Service, Both, or Other, add optional customer details and a note,
adjust who it goes to, preview the email, and send.

- **Team lists** live in **Settings > Escalation teams**, per store: Sales,
  Service, and Entire store. Sales concerns go to Sales, Service to Service,
  Both to both lists, Other to Entire store. The person escalating can switch to
  the entire store, remove people, or add one-off people for that email only.
- Only addresses on the domains in `MAIL_ALLOWED_DOMAINS` can receive escalations.
- Emails send from the escalating person's own Microsoft 365 mailbox, so
  replies go to them and a copy lands in their Sent Items.
- Each review shows how many emails have been sent about it, when the last one
  went out, and how many follow-ups have gone out without resolution. **Mark
  resolved** resets the follow-up count; the total keeps counting.
- Customer details typed into the form go in the email only. The dashboard
  stores who sent it, when, to whom, and the concern type, but not the customer
  details or the note.

**How sending works.** At sign-in, Microsoft asks each person once to let the app
send email as them (or IT approves it for everyone). The app gets a token that
can only send as that person, stores it encrypted, and deletes it when they sign
out. If a token stops working, the dashboard asks them to sign out and back in.

**One-time setup**
1. Run the SQL in `migrations/0003_escalations.sql` in the D1 console. Run it
   once only (a second run gives harmless "duplicate column" errors). Then run
   `migrations/0004_user_tokens.sql`.
2. IT adds two **delegated** Microsoft Graph permissions to the Lester Glenn
   Reviews app registration, **Mail.Send** and **offline_access**, and clicks
   **Grant admin consent**. Delegated Mail.Send only allows sending as the person
   who is signed in. No shared mailbox is needed.
3. In `wrangler.toml`, `MAIL_ALLOWED_DOMAINS` controls which domains can receive
   escalations (default `lesterglenn.com`, comma-separated for more).
4. Everyone who was already signed in signs out and back in once.

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

Sign-in sessions last 12 hours. Renewing the Microsoft client secret signs
everyone out once, which is expected.

## Privacy and safety

- Reviewer names are dropped the moment a review is read and are never stored,
  sent to Claude, or shown in the dashboard.
- A review that already has a reply in Google is never replied to again.
- Nothing auto-posts unless the keyword check and Claude's risk rating both clear it.
- Every draft, edit, approval, dismissal, and post is recorded in the review's history.
