# wzrdmail Console — specification of record

Hostname: **`console.mail.wzrd.tech`** (staging: `staging.console.mail.wzrd.tech`).
This supersedes every `console.wzrd.tech` reference in `goal.md` §12 and elsewhere.

The console is the human-facing dashboard for wzrdmail organizations: provision
inboxes, read mail, mint API keys, configure webhooks and domains, watch usage
and deliverability, manage allow/block lists, and pay. It is modeled on the
AgentMail dashboard (reference screenshots, 2026-08-31) and adapted to
wzrdmail's domain model (`goal.md` §4) and plans (`packages/core/src/plans.ts`).

## 0. Definition of done

A human can, in one sitting on `console.mail.wzrd.tech`:

1. Sign in with email + OTP (the OTP delivered by wzrdmail itself).
2. See the Overview with real 24h send/receive/bounce counts and latest threads.
3. Create an inbox, open it, read a thread with rendered extracted text, and reply.
4. Mint a scoped API key (shown once), see it listed masked with last-used.
5. Add a webhook endpoint, see the event catalog, and inspect recent deliveries.
6. See usage bars against their plan limits and hit Upgrade → Stripe Checkout.

No console-only enforcement: every limit shown is enforced server-side (§2 of goal.md).

## 1. Architecture

- `apps/console` — React 18 + Vite + TanStack Router SPA. Dark theme default
  (AgentMail-style), light theme toggle. Served as static assets from its own
  Worker (`services/console-host` pattern like `services/www`), custom domains
  `console.mail.wzrd.tech` / `staging.console.mail.wzrd.tech`.
- Talks only to the public API (`api.wzrd.tech/v0/*`) plus a session-auth route
  group `api.wzrd.tech/v0/console/*` (login, session, seat management). No
  second API; every list/table the console renders is a public `/v0` endpoint
  an agent could also call.
- Session auth: email + OTP (reuses `otp_codes` with purpose `console_login`),
  httpOnly session cookie (D1 `sessions` table, 30-day TTL, rotating).
  CORS: the API allows credentialed requests from the console origin only.
- State/data fetching: TanStack Query; all lists paginated with `page_token`.

## 2. Navigation & layout

Left sidebar (fixed):
- Org switcher (org name + plan badge, e.g. "Free Tier") at top.
- Pod selector ("All pods" dropdown) — filters every page below it.
- Sections: **Overview, Inboxes, Metrics** · **Domains, Webhooks, API Keys, Lists**
- Bottom: Settings, Upgrade (highlighted), Help, user chip (name/email + sign out).

Top bar: breadcrumb (`Dashboard → <page>`), search (mail pages), theme toggle.

Recurring patterns from the reference screenshots:
- **"USE API" panel**: every resource page has a `USE API` button opening a right
  drawer with (a) a copyable "coding agent" prompt describing the operation in
  context, (b) SDK & CLI tabs — cURL / CLI / Python / TypeScript — with working,
  copyable snippets against `api.wzrd.tech`, scoped to the current org/pod.
  This is a first-class feature, not an afterthought: wzrdmail's users are
  agents; the console teaches the API everywhere.
- Capacity bars: e.g. inbox count vs plan limit with red bar when exhausted and
  "Compare plans ↗" link.
- Empty states with a single primary action (e.g. "No custom domains yet → Add Domain").

## 3. Pages

### 3.1 Overview (`/`)
- Greeting header ("The day in view, <name>."), period picker (24h/7d/30d),
  "View metrics →".
- Stat row: Messages sent · received · Bounced · Rejected · Complained (period).
- Activity chart (line/bar toggle, Sent+Received selector) from `usage_counters`
  + `events` aggregates.
- **Delivery health** card: delivered/failed/complaints for period, empty state
  "No mail activity in this period."
- **Resources** card: active inboxes n/limit with capacity bar; domains count.
- **Latest conversations**: most recent threads across the org (unread count,
  "8 unread across 8 threads"), each row → thread view; "View all →" → Inboxes.
- Banner: "Add a custom domain — send from your own domain" (dismissible; links
  to Domains).

### 3.2 Inboxes (`/inboxes`)
- Hero header + actions: `USE API`, `SMTP/IMAP` (v1: informational modal —
  "coming later"; wzrdmail is API-first), `+ Create Inbox` (username, domain
  select — `wzrd.tech` or a verified custom domain — display name, pod).
- **Unified Inbox** card → `/inboxes/all`: every message across all inboxes,
  one thread list.
- Capacity bar: `<n> remaining` vs plan limit, red when 0, "Compare plans ↗".
- Table: inbox avatar + address, pod chip, created; overflow menu (rename
  display name, move pod, delete with confirm-by-typing-address).

### 3.3 Inbox mail view (`/inboxes/:inboxId`)
Gmail-like three-zone layout:
- Left rail: **Compose** button; labels: Inbox, Sent, Drafts, Scheduled
  (v1: hidden unless `send_at` exists), All Mail, Trash, Other (custom labels);
  below: **API Keys** (inbox-scoped) and **Allow/Block Lists** (inbox-scoped).
- Thread list: unread dot, sender, subject — snippet, timestamp; pagination
  (`30 ▾` page size); multi-select + label actions; search-in-mail box (server
  `q=` search).
- Thread view: messages expanded with sanitized rendered `extracted_html`
  (DOMPurify equivalent server- or client-side; never raw HTML), attachment
  chips (download via `/attachments`), reply/reply-all/forward box for humans,
  label chips, read/unread toggle, View raw (`.eml` download).
- Inbox-scoped API Keys page (`/inboxes/:id/api-keys`): keys that authenticate
  only as this inbox ("Keys created here can authenticate only as
  `<address>`."): name, masked key `wm_…•••`, permission chips, created,
  last-used, delete.

### 3.4 Metrics (`/metrics`)
- Filters: period (24h/7d/30d/custom, TZ label), inbox selector (All inboxes).
- **Activity**: email activity chart with event-type selector (Sent, Received,
  Complained, Bounced); 30-day message activity card (calendar heat grid,
  30-day sent/received, busiest day, longest streak).
- **Needs attention** card: derived warnings (all inboxes used, bounce rate
  near risk, unverified org, webhook failures).
- **Deliverability**: Successful %, Delivered/Bounced/Rejected counts; bounce
  rate and complaint rate charts with dashed RISK threshold lines (5% / 0.1%).
- **Diagnostics**: Inbound filtering ("Mail held outside Inbox": spam, blocked,
  unauthenticated counts) and Failure diagnosis ("Affected recipient domains":
  bounced/rejected/complained by recipient domain).
- **Resources**: resource history — inboxes n/limit, pods, domains, threads,
  messages, storage used vs plan cap; change over the period.

### 3.5 Domains (`/domains`)
- Plan gate banner: "Upgrade to Developer or Startup plan to use custom domains."
- Empty state → `+ Add Domain` wizard: enter domain → show required DNS records
  (MX, SPF, DKIM, DMARC, verification TXT) in a copyable table → live
  verification status polling → `domain.verified` event on success.
- Table: domain, status (pending/verified/failed), inbox count, created.

### 3.6 Webhooks (`/webhooks`)
Tabbed page:
- **Endpoints**: table (URL, error rate chip), `+ Add Endpoint` (URL, event
  filter, inbox filter), detail drawer: masked secret + rotate, enable/disable,
  delete.
- **Event Catalog**: every event type with expandable JSON schema + sample
  payload (`message.received`, `message.sent`, `message.delivered`,
  `message.bounced`, `message.complained`, `message.rejected`,
  `domain.verified`, …) — generated from `packages/core` schemas.
- **Logs**: recent deliveries — event, endpoint, HTTP status, latency,
  timestamp; payload inspector; **Redeliver** button.
- **Activity**: delivery success/error-rate chart per endpoint.

### 3.7 API Keys (`/api-keys`) — org level
- Table: name, scope (Organization / Pod / Inbox chip with target), masked key
  (`wm_…•••`), permission chips (Full Access / read / send / admin), created,
  last-used, delete.
- `+ Create API Key`: name, scope selector, permissions; **reveal-once** modal
  with copy button ("you will not see this again").

### 3.8 Lists (`/lists`) — Allow & Block lists
- Three sections: **Receive**, **Send**, **Reply** — each with an Allow List
  and Block List card (`+ Add` address or domain pattern, e.g. `*@spam.com`).
- Enforcement is server-side at ingress (receive) and egress (send/reply);
  suppressions (bounce/complaint) surface here read-only with source labels.
- Org-wide page; inbox-scoped lists reachable from the inbox left rail.

### 3.9 Settings (`/settings`)
- Org: name, org id (copyable), verification status.
- Members & seats: invite by email (seat-limited by plan), roles (owner/member),
  remove.
- Billing: current plan, usage summary, Upgrade/Manage → Stripe Checkout/Portal,
  invoices.
- Danger zone: delete org (types org name; blocked while subscription active).

### 3.10 Upgrade (`/upgrade`)
- Plan comparison table straight from `plans.ts` (free / developer $20 /
  startup $200 / enterprise "contact us"); current-plan highlight; checkout via
  Stripe (goal.md §13). Every capacity bar and plan-gate banner links here.

## 4. API surface the console needs (gap list)

Exists today: inbox CRUD, message/thread list+get+raw+attachments, label/read
mutations, webhook CRUD, agent OTP.

To add (all public `/v0`, agent-usable, SDK-parity):
1. `GET /v0/metrics?period=&inbox_id=` — aggregated counts (sent, received,
   bounced, complained, rejected, delivered) bucketed by hour/day, from
   `usage_counters` + `events`.
2. `GET /v0/usage` — current-month metrics vs plan limits (drives every
   capacity bar).
3. API key CRUD: `GET/POST/DELETE /v0/api-keys` (scoped create, reveal-once,
   `last_used_at` updated on auth).
4. Webhook deliveries: `GET /v0/webhooks/:id/deliveries`, `POST …/redeliver`.
5. Lists: `GET/POST/DELETE /v0/lists/{receive|send|reply}/{allow|block}`;
   `GET /v0/suppressions` read-only.
6. Domains: `GET/POST/DELETE /v0/domains`, `GET /v0/domains/:id/verify`
   (plan-gated; §M4 of goal.md).
7. Console session group: `POST /v0/console/login` (send OTP),
   `POST /v0/console/verify` (set cookie), `GET /v0/console/session`,
   `POST /v0/console/logout`, member invite endpoints.

## 5. Milestones

- **C0 — Spec + host**: this document; `console.mail.wzrd.tech` +
  staging custom domains registered; console Worker serving a placeholder.
- **C1 — Shell + auth**: SPA scaffold, sidebar/nav/theme, email-OTP login,
  session cookies, org switcher.
- **C2 — Inboxes + mail**: inbox list/create/capacity bar, unified inbox,
  thread list/view, reply, labels, USE API drawers.
- **C3 — Keys + webhooks**: API key CRUD (API + UI), webhook endpoints/event
  catalog/logs/redeliver.
- **C4 — Metrics + overview**: metrics/usage endpoints, overview page, metrics
  page, needs-attention.
- **C5 — Lists + domains**: allow/block list API + UI, domains wizard
  (plan-gated), suppressions view.
- **C6 — Billing + settings**: Stripe checkout/portal wiring, members/seats,
  upgrade page; Playwright E2E of §0 on staging.

Each milestone lands as its own PR, deployed to staging before production.
