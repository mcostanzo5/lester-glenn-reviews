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
| `src/staff.ts` | Finds employee names in reviews, matches them to each store's roster, tallies by month |
| `src/feedback.ts` | Thumbs up/down on drafts: liked examples and lessons for future drafts |
| `src/backup.ts` | Weekly backup of the database to SharePoint |
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

## Staff tallies

The **Staff** tab counts how many reviews name each salesperson, service advisor,
or other employee, for any range of calendar months (Eastern time), split by
4 to 5 stars, 3 stars, and 1 to 2 stars. Click a name to see the reviews, or
download a CSV.

- **Reading reviews for names.** Claude reads each review for employee names and
  whether they're in sales or service, 25 reviews per request. New reviews are
  read automatically on each agent run. For older months, pick the range on the
  Staff tab and click **Read reviews now**. If a customer edits a review, it's
  read again.
- **Rosters.** Each store has a staff roster (Staff tab, bottom). Names are
  matched to that store's roster: full name or nickname first, then first name
  plus last name or last initial, then the sales or service hint from the review.
  Add nicknames (Mike for Michael) so more names match on their own.
- **Two people with the same first name.** If the review can't tell them apart
  (for example two sales Mikes), the mention goes to **Needs tagging** and isn't
  counted until someone picks the right person. Hand tags are never changed by
  the agent, including if the review is read again.
- **Who can tag.** Admins and reply approvers can tag and edit rosters. Managers
  and view-only users can see tallies for their stores. People who leave can be
  set inactive; their past counts stay.

One-time setup: run `migrations/0006_staff_mentions.sql` in the D1 console.

## Who can do what

| | Approvers | Admins | Managers | View only | Escalation recipients |
|---|---|---|---|---|---|
| Approve, edit, redraft, dismiss replies | Yes | Only if also an approver | No | No | No |
| See drafts | Yes | Yes (read-only) | Yes (read-only) | Yes (read-only) | No |
| Escalate, follow up, mark resolved | Yes | Yes | Their stores | No | No |
| Inbox, all reviews, statistics | Yes | Yes | Their stores | Their stores | No |
| Settings | If admin | Yes | No | No | No |
| Open a review from an escalation email | Yes | Yes | Yes | Yes | Only reviews sent to them |

**Approvers** are set in `REPLY_APPROVERS` in `wrangler.toml` (currently
mcostanzo@ and mbellina@). An approver who isn't listed in Settings still gets
in, with access to every store.

**Escalation recipients** are anyone in the Microsoft tenant who isn't in
Settings. When they open "Open the review" from an escalation email, they get a
read-only page with the review, the escalation details and notes, and its
history. They can only open reviews that were escalated to them; a forwarded
link won't work for anyone else.

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
- The last escalation's concern, customer details, note, and recipients are
  saved with the review, encrypted, so a follow-up starts filled in (the previous
  note is shown for reference and the new note starts blank). Only people who can
  act on that store see them. Storing customer details was approved by Matt
  Costanzo per company PII policy. Renewing the Microsoft client secret makes
  previously saved details unreadable, so those follow-ups start blank once.

**How sending works.** At sign-in, Microsoft asks each person once to let the app
send email as them (or IT approves it for everyone). The app gets a token that
can only send as that person, stores it encrypted, and deletes it when they sign
out. If a token stops working, the dashboard asks them to sign out and back in.

**One-time setup**
1. Run the SQL in `migrations/0003_escalations.sql` in the D1 console. Run it
   once only (a second run gives harmless "duplicate column" errors). Then run
   `migrations/0004_user_tokens.sql` and `migrations/0005_escalation_details.sql`. For manual escalations and notes, also run `migrations/0008_manual_reviews_and_notes.sql`, then `migrations/0009_removed_and_reassigned.sql`, `migrations/0010_insights.sql`, `migrations/0011_feedback.sql` and `migrations/0012_updated_reviews.sql`.
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

## Topics and word clouds

When reviews are read for staff names, Claude also tags each one with themes
(from a fixed list: Sales experience, Pricing and fees, Financing and F&I, Wait
time, Communication, and so on) and up to 5 short key phrases ("oil change", "no
pressure", "hidden fees"), each marked positive, negative or neutral. The
**Topics** tab shows a word cloud for the store picked in the left panel (or all
stores) and a range of months: bigger words come up in more reviews, green means
mostly positive, red mostly negative. Click a word or theme for how many reviews
mention it, its share of reviews, its month-by-month trend, and the reviews
themselves. For older months, click **Read reviews now** on the Topics or Staff tab.

## Escalation outcomes and recovered reviews

Marking an escalation resolved asks what happened (customer contacted, issue
resolved, customer updated the review, customer removed the review, couldn't
reach the customer, other) plus an optional note. The agent also records every
star-rating change. Statistics shows how escalations were resolved, the average
days to resolve, and **recovered reviews**: escalated reviews whose rating went up
afterward or that were removed, with a recovery rate per store.

## Thumbs up and down on drafts

Approvers can rate any draft. **Thumbs up** saves it as a good example: future
drafts for reviews with a similar rating (4-5 stars, 3 stars, or 1-2 stars) use
up to three liked replies as style examples. **Thumbs down** asks what should
change, redrafts with that note, and, if the note applies to replies in general,
adds it as a short lesson to **Settings > Reply guidelines > Lessons from
feedback**. Every future draft follows those lessons; remove any you don't want.
Notes about one specific review (a detail to add) are used for that redraft only.

## Learning from edits

Claude's original draft is kept. When an approver changes it before approving,
the before-and-after is saved. **Settings > Reply guidelines > Suggest updates
from our edits** has Claude look for patterns in those changes and propose
updated guidelines, with a summary of what it noticed. Nothing changes until you
save.

## Weekly backup

Every Sunday at 8pm Eastern (and on demand from Settings), the whole database is
saved to a SharePoint folder: a full backup (`.json.gz`) and a reviews spreadsheet
(`.csv`). The last `BACKUP_KEEP` weeks (default 12) are kept. Notes and escalation
details stay encrypted in the backup; stored Microsoft sign-ins are never included.
Needs Workers Paid, since packaging the database takes more processing than the
free plan allows per request.

Setup:
1. IT adds the **delegated** Microsoft Graph permission **Files.ReadWrite.All**
   to the app registration and grants admin consent.
2. Then set `BACKUP_SITE` in wrangler.toml to the SharePoint site (for example
   `lesterglenn.sharepoint.com/sites/Marketing`) and deploy. Don't set it before
   step 1, or sign-in will ask for a permission that hasn't been approved.
3. `BACKUP_USER` signs out and back in once. The folder is created on the first backup.

## Reviews the reviewer updates

When a reviewer changes their review text or star rating, even on a review that
already has a reply, it goes back to the Inbox right after escalations with an
orange **Updated** tag, and the run notes say how many. The review shows the old
and new rating, what it said before, and the reply currently on Google. Claude
drafts a reply to the review as it reads now; **Approve and replace reply**
replaces the old reply on Google. Behind-the-scenes Google updates with no real
change are ignored.

## Removed reviews

Google's list only includes reviews that still exist, so the agent watches for
reviews that disappear, whether answered or not:
- **Every run, at no extra cost:** each listing's newest page (which the agent
  downloads anyway) is compared with what we have for the same stretch of time.
- **A rolling sweep:** leftover requests each run walk older pages back to
  `HISTORY_START`, rotating through listings, so older deletions are caught
  within a few days.
- **Direct lookups:** a few reviews per run are looked up one by one, escalated
  reviews first, since those are often deleted after a store resolves them.

Removed reviews drop out of the Inbox, Statistics and staff tallies; find them in
All reviews with the "Removed from Google" filter. **Check on Google** on a
review checks it right away. A review that shows up on Google again is restored
automatically.

Google's Business Profile API sometimes keeps listing a review for a while after
it's gone from the public profile. When you know a review is gone, click **Mark
as removed**: it stays removed even while Google's system still lists it, and
**Undo removed** brings it back. If the reviewer later changes the review text,
it comes back automatically, since that means it's a live review again.

## Auto Group reviews about a specific store

Reviews on the Lester Glenn Auto Group listing have a store picker. Moving one
to a store counts it in that store's stats, sends escalations to that store's
teams, and matches staff names against that store's roster. The reply still
comes from the Auto Group listing, since that's where it's posted. The move
sticks through future syncs, and it can be moved back.

## Manual escalations (other review sites)

**Manual Escalation** in the header adds a review from DealerRater, Yelp, Facebook,
Cars.com, CarGurus, BBB, Edmunds, Autotrader, or any other site: pick the store
and site, paste the review, add the star rating, date, reviewer name and link if
you have them, then fill in the escalation email as usual. The review shows in
that store's All reviews and Escalations, tagged with its site.

These reviews can't be posted to from here. Draft a response, click **Copy**,
post it on the site, then click **Mark as responded**. They're left out of
Statistics (which covers Google), but staff named in them still count on the
Staff tab. A review added by mistake can be deleted from its panel.

## Management notes

Every review has a **Management notes** section for background from the store
team (paste the manager's email, or type what happened and what was done). Notes
are stored encrypted and are internal only. **Draft a reply with these notes**
writes a reply that reflects them without quoting them or revealing customer or
deal details, and it always waits for an approver. Escalation recipients see the
notes on their read-only page.

## Inbox and approvals

The Inbox is every review without a reply, most urgent first: open escalations
(shown with a red frame), flagged drafts, failed posts, reviews waiting for a
draft, drafts ready for approval, approved replies waiting to go live, then
older unanswered reviews from the current calendar year (Eastern). Unanswered
reviews from earlier years stay in All reviews but not the Inbox, unless they're
escalated or have a draft waiting. With `AUTO_POST = "off"` (the default), nothing posts
until an approver clicks Approve and post, even in live mode.

## Where the Worker runs

`[placement]` in `wrangler.toml` pins the Worker near AWS us-east-1 (Virginia).
Cloudflare can start scheduled runs in any data center, including places Claude
doesn't serve, so each scheduled run hands its work to the Worker's own address
(`SELF_URL`), which runs in the pinned location. If a Claude call still fails
with a temporary error, that review waits and is drafted on the next run.

## History cutoff

The agent only imports Google reviews written on or after `HISTORY_START` in
`wrangler.toml` (default `2024-01-01`, Eastern time). Older reviews already in the
database stay. When a listing's import reaches the cutoff, it's marked Complete.

## Modes

Scheduled runs happen at 8am, 12pm, 4pm, and 8pm Eastern all year, including
across daylight saving changes. To change the times, edit `RUN_HOURS_ET` and
`crons` in `wrangler.toml` (the comment there explains how) and deploy.
Admins can also click **Run agent now** in Settings at any time.


| Mode | Reads Google | Posts | Scheduled runs |
|---|---|---|---|
| `dry_run` | No, sample data only | Never | Paused (use Run agent now) |
| `shadow` | Yes | Never | 4 times a day |
| `live` | Yes | Approved replies (plus clean 4-5 star drafts only if `AUTO_POST = "on"`) | 4 times a day |

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

- Reviewer names (as Google shows them) are stored and shown to people with
  dashboard access, and are searchable in All reviews. Claude only receives the
  reviewer's first name, to greet them in replies. Anonymous reviewers and
  business names get no greeting by name. People opening a review from an
  escalation email don't see the reviewer's name. Approved by Matt Costanzo per
  company PII policy. Setup: run `migrations/0007_reviewer_names.sql`.
- A review that already has a reply in Google is never replied to again.
- Nothing auto-posts unless the keyword check and Claude's risk rating both clear it.
- Every draft, edit, approval, dismissal, and post is recorded in the review's history.
