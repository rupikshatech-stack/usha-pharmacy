# Usha Pharmacy — Wholesale ERP

A multi-tenant ERP for pharmacy wholesalers and retailers: stock and batch management,
GST-compliant billing, sales returns, inter-store transfers, supplier purchasing, credit,
and business analytics. One deployment serves many pharmacies, each seeing only its own data.

New pharmacies are onboarded by an internal platform administrator — there is no public signup.

## Stack

| | |
|---|---|
| **Client** | React 19, Vite 8, Tailwind 4, React Router 7, Axios, Recharts, lucide-react |
| **Server** | Express 5, Mongoose 9, zod 4, JWT + httpOnly cookies, bcryptjs, helmet, nodemailer |
| **Database** | MongoDB with a **replica set** (transactions are used for stock and billing) |
| **Tests** | `node --test`, `mongodb-memory-server`, Playwright-driven browser checks |
| **Lint** | oxlint |

Plain JavaScript (ESM) throughout — not TypeScript. zod schemas are the request contract.

Node.js 20+. In development MongoDB is **optional**: an embedded single-node replica set starts
automatically on port 27018 (data in `server/.data`). Production needs a real replica set such as Atlas.

## Getting started

There are separate `package.json` files at the root, in `client/`, in `server/` and in `e2e/`. The
root one orchestrates; install root, server and client in one step:

```bash
npm run install:all
cp server/.env.example server/.env
cp client/.env.example client/.env.local      # optional in development
npm run seed                                  # first organization + its administrator
npm run dev                                   # API on :4000, web app on :5173
```

Edit `server/.env` before seeding: set `JWT_SECRET` and `ADMIN_INITIAL_PASSWORD`.
Open <http://localhost:5173>. Health check: `GET http://localhost:4000/api/health`.

`npm run seed` is safe to repeat — it never overwrites or duplicates an existing account.
The browser suite in `e2e/` has its own dependencies: run `npm install` there once if you want it.

### Running the backend and frontend separately

`npm run dev` just starts two independent processes. Run them on their own when you only need one, or want
separate terminals:

| | Command | Listens on |
|---|---|---|
| Backend (API) | `npm run dev:server` | <http://localhost:4000> — nodemon restarts it on change |
| Frontend (web app) | `npm run dev:client` | <http://localhost:5173> — Vite, which proxies `/api` to the backend |

The frontend does nothing useful without the backend: every page, including sign-in, calls the API. Vite sends
`/api` to `VITE_DEV_API_TARGET` (default `http://localhost:4000`). The backend needs no MongoDB install in
development; it starts the embedded replica set on port 27018 unless `MONGODB_URI` is set.

### Environment — `server/.env`

Variables are validated at startup; the server exits naming any that are invalid. Real environment
variables win over the file. **Never commit `.env` files** (they are git-ignored).

**Database and server**

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT` | Mode and API port (4000) |
| `CLIENT_ORIGIN` | Comma-separated origins allowed by CORS |
| `MONGODB_URI` | Leave **empty in development** to use the embedded replica set. Required in production |

**Auth and sessions**

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs access tokens. Must be set |
| `ACCESS_TOKEN_MINUTES`, `SESSION_HOURS`, `REMEMBER_ME_DAYS` | Token and session lifetimes |
| `COOKIE_SAME_SITE` | `lax` normally; `none` only behind HTTPS on a different domain |
| `MAX_FAILED_LOGINS`, `LOCKOUT_MINUTES` | Per-account brute-force lockout |

**First organization** (used only by `npm run seed`)

| Variable | Purpose |
|---|---|
| `ADMIN_ORG_NAME`, `ADMIN_NAME`, `ADMIN_EMAIL` | The organization and its first administrator |
| `ADMIN_INITIAL_PASSWORD` | 8–72 characters with upper, lower, a number and a symbol |
| `ADMIN_REQUIRE_PASSWORD_CHANGE` | `true` forces a new password at first sign-in |

**Platform administrator** (used only by `scripts/create-platform-admin.js`)

| Variable | Purpose |
|---|---|
| `PLATFORM_ADMIN_NAME`, `PLATFORM_ADMIN_EMAIL` | The operator who onboards new pharmacies |
| `PLATFORM_ADMIN_INITIAL_PASSWORD` | Good for one sign-in; a password change is forced |

**Email** (near-expiry digest)

| Variable | Purpose |
|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | SMTP server |
| `MAIL_FROM` | From address |
| `APP_URL` | Public address of the web app, for links inside emails |

> With `SMTP_HOST` unset, a console mailer logs messages and **sends nothing**. That is the default
> so a half-configured install cannot mail real pharmacies.

**Other**: `UPLOAD_DIR` (file storage, default `server/uploads`); optional upload limits
`SETTINGS_LOGO_MAX_MB` (2), `SETTINGS_DOCUMENT_MAX_MB` (5) and `PRODUCT_IMAGE_MAX_MB` (5); `SETTINGS_ORPHAN_HOURS`
(24), how old an unattached upload must be before `scripts/cleanup-uploads.js` removes it; and the AI-billing and
invoice-reading keys (`AI_BILLING_*`, `GOOGLE_*`, `GEMINI_API_KEY`, `OPENAI_API_KEY`), documented in
[docs/invoice-reading-setup.md](docs/invoice-reading-setup.md).

### Environment — `client/.env.local`

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Empty in development (Vite proxies `/api`); the full API URL in production |
| `VITE_DEV_API_TARGET` | Where the dev server proxies `/api` to |

Only `VITE_`-prefixed variables reach the browser — never put a secret here.

## Project structure

```
usha-pharmacy/
├── client/      React app — components, pages, hooks, context, services, utils
├── server/      Express API
│   ├── config/        validated env, database, permissions catalogue
│   ├── controllers/   thin request handlers
│   ├── services/      business logic (stock, invoices, analytics, settings, roles, email)
│   ├── models/        Mongoose models — every tenant record carries organizationId
│   ├── validators/    zod request schemas
│   ├── middleware/    auth, tenant scoping, CSRF, validation, errors
│   ├── routes/        URL wiring
│   ├── scripts/       migrations, seeds and one-off operational tools
│   └── tests/         server test suite
├── e2e/         browser tests and the cross-module "crossings" suite
└── docs/        deeper reference: module detail, invoice-reading setup, Vercel deployment
```

## Modules

The sidebar, in order. Everything is scoped to the signed-in user's organization. Per-module
detail — endpoints, rules, edge cases — is in [docs/modules.md](docs/modules.md).

**Dashboard** — stock, sales and alert summary, with a notification bell driven by the
organization's own notification settings.

**Selling Point** — the till. Search or scan, build a cart, take Cash / UPI / Card / Credit, print.
GST is inside the price, never added on top. Keyboard-driven (F1–F10), with held bills.

**Recent Invoices** — completed invoices, searchable, with line detail.

**Stock Management**

| Page | What it holds |
|---|---|
| All Inventory | Medicines, stock levels, reorder status |
| All Compound | Compound formulas and their ingredients |
| Inventory Batch | Every batch: expiry, quantity, cost, supplier, movement history |
| Inter Store Transfer | Branch-to-branch transfers: draft → submit → approve → dispatch → receive |
| Import Inventory | CSV import with preview, row-level validation, confirm or cancel |
| Attributes | Dosage forms, strengths, units and custom attributes |

**Sales Returns** — return part or all of an invoice, with reason and condition per line, optional
restock to the original batch, and refund tracking.

**Orders** — purchase orders to suppliers, with approval where the organization requires it.
Includes **AI Billing**, which reads a supplier invoice document and drafts a goods receipt from it
(setup in [docs/invoice-reading-setup.md](docs/invoice-reading-setup.md)).

**Branch** — the organization's stores.

**Credit Management** — the customer credit-request system: a request is raised, proof of payment is
uploaded, and an administrator approves or rejects it. *Money owed on a credit invoice is accounts
receivable and is reported under Customer Insights, not here.*

**Suppliers** — supplier records, procurement terms, and purchase history.

**Business Analytics** — every figure is aggregated in MongoDB from live records; there is no
reporting copy of anything.

| Page | What it answers |
|---|---|
| Overview | The headline numbers and trends |
| Sales Report | Sales by period, payment mode, cashier, customer |
| Purchase Report | What was bought, from whom, and what is still owed |
| Profitability | Margin by medicine, category and period |
| Inventory Analytics | Stock value, movement and dead stock |
| Low Stock | What has fallen below its reorder level |
| Expiry Intelligence | Batches by expiry tier, with FEFO sell-through risk and clearance / supplier-return suggestions |
| GST Report | Output and input tax, net of returns |
| Customer Insights | Who buys what, and **what customers still owe** |
| Supplier Performance | Order volume, value, lead time and return rate |
| Branch Performance | Store-by-store comparison |

**Activity Log** — an append-only record of who changed what, scoped to the organization.

**Roles & Users** — the five built-in roles (Organization Admin, Branch Manager, Inventory Manager,
Billing Staff, Staff) plus any custom roles, with a grouped permission picker; and the people who
hold them. Users are deactivated, never deleted, so historical records keep reading correctly.

**Settings** — Organization Profile (licences, GSTIN, bank, logo), Invoice Customization (numbering,
layout, live preview) and Common Settings (billing rules, expiry thresholds, notifications).

**Platform** (`/platform`) — **deliberately not linked from the application.** A platform
administrator signs in here to onboard a new pharmacy: it creates the organization, its five system
roles and its first administrator in one transaction, and shows the temporary credentials once.
A platform account belongs to no organization and cannot read any pharmacy's data.

## Multi-tenancy

Every tenant record carries an `organizationId`, and a Mongoose plugin (`tenantScope`) forces it
onto every query, update and insert inside a request. A request's organization comes only from the
authenticated user's database record — never from anything the client sends. Any write outside an
HTTP request (a script, a seed, a test) must be wrapped in `runWithTenant(orgId, fn)` or it throws.

**Roles** are rows in a `roles` collection, not words in code. Each organization starts with five
system roles whose permissions match the built-in defaults; they can be edited but not renamed or
deleted. An organization can add its own roles on top. Permissions are read fresh from the database
on every request, so a role change takes effect on the holder's next request — they are never
carried in a token.

**Onboarding** goes through the platform flow at `/platform`, which is the only way a new
organization is created other than the initial `npm run seed`.

## Scheduled jobs

One job exists: the **near-expiry email digest** — a daily, per-organization email listing batches
that have newly become urgent, grouped by that organization's own expiry thresholds.

```bash
node scripts/run-expiry-alerts.js --dry-run            # default: builds the real digests, sends nothing
node scripts/run-expiry-alerts.js --apply
node scripts/run-expiry-alerts.js --apply --ethereal   # throwaway inbox + preview link
```

Run from `server/`. It is **not registered with Task Scheduler** — that is a deliberate manual step.
Setup instructions, the two settings a pharmacy needs (one of which cannot yet be set from the Settings screen),
and how duplicate alerts are prevented
are in [docs/modules.md](docs/modules.md#scheduled-jobs--near-expiry-email-digest).

## Scripts

### npm scripts (root)

| Script | What it does |
|---|---|
| `npm run install:all` | Installs root, server and client dependencies |
| `npm run dev` | API (:4000) and web app (:5173) together |
| `npm run dev:server` / `dev:client` | One side only |
| `npm run build` | Production build of the client |
| `npm start` | API in production mode |
| `npm run lint` | oxlint over the client |
| `npm test` | Both suites — server, then client |
| `npm run test:server` / `test:client` | One suite |
| `npm run verify` | **The gate.** lint → build → client tests → server tests → crossings |
| `npm run verify:crossings` | The cross-module suite alone |
| `npm run seed` | Creates the first organization and administrator |
| `npm run migrate` | Runs every migration in order |

### Operational scripts (`server/scripts/`)

Run from `server/`. The tools that change data default to a **dry run** and need an explicit
`--apply`. **Take a backup before any `--apply`.**

| Script | What it does | Safe to re-run? |
|---|---|---|
| `seed.js` | First organization + administrator | Yes — does nothing if the account exists |
| `migrate-settings.js` | Fills in settings defaults, derives PANs, raises document counters | Yes — idempotent |
| `migrate-roles.js` | Creates the five system-role rows per organization | Yes — creates only what is missing |
| `migrate-expiry-alerts.js` | Creates the alert collections and their unique indexes | Yes — backfills nothing |
| `create-platform-admin.js` | Creates the platform administrator from `PLATFORM_*` | Yes — never overwrites an account |
| `seed-invoice-counters.js` | Raises document counters from existing documents | Yes — only ever raises |
| `correct-invoice-counter.js` | **Lowers** a counter that is wrong, in one audited transaction | Refuses if any document sits above the target |
| `remove-organization.js` | Removes an organization that never traded | Refuses any organization with business records |
| `run-expiry-alerts.js` | Sends the near-expiry digest | Yes — one digest per organization per day |
| `cleanup-uploads.js` | Deletes uploads never attached to anything (24h+) | Yes |
| `seed-expiry-demo.js` | Demo expiry data for development | Replaces its own demo rows |

The earlier migrations (`migrate-tenancy`, `-dashboard`, `-inventory`, `-transfers`, `-suppliers`,
`-analytics`, `-expiry`) are part of `npm run migrate` and are idempotent.

## Testing

```bash
npm run verify        # the whole gate, about 7 minutes
```

In order — cheapest and most specific first, so a syntax error fails in seconds rather than after
the server suite:

| Stage | Checks | Baseline |
|---|---|---|
| `lint` | oxlint over the client | 0 errors, 31 warnings |
| `build` | The client actually compiles | ~1 s |
| `test:client` | Pure client logic — validation, bill maths, formatting | 363 passing |
| `test:server` | API, tenancy, permissions, stock, billing, analytics, migrations | 1,565 passing |
| `verify:crossings` | 17 cross-module journeys over real HTTP | 17 passing |

> **Lint is not a syntax gate.** oxlint accepts invalid JSX that the build rejects, which is why
> `build` is part of `verify` and not an afterthought.

### The crossings suite (`e2e/crossings/`)

Seventeen journeys that each span several modules — onboarding through to tenant isolation, a
settings change reaching the till total, a return's effect on the GST report, a transfer's effect on
both stores' stock, branch scoping in analytics, and every write landing in the Activity Log. Every
assertion goes through the HTTP API the browser uses.

It **starts its own throwaway stack** on a free port, runs against it and stops it, so it cannot
touch the development database. Several steps assume a clean database and will legitimately disagree
on a second run against the same stack — which is why the suite owns the stack's lifecycle rather
than trusting anybody to restart one.

```bash
npm run verify:crossings                # from the root
cd e2e && node crossings.mjs --keep     # leave the stack up afterwards, to poke at
```

`cd e2e && npm run e2e` runs the separate browser suite: real Chrome on a desktop and a phone-sized
screen, with an accessibility scan of every page in both themes.

## Git workflow

The repository uses **simple-git-hooks**, installed by `npm install` through the `prepare` script:

| Hook | Runs | Takes |
|---|---|---|
| `pre-commit` | `npm run lint` | a few seconds |
| `pre-push` | `npm run verify` | about 7 minutes |

`SKIP_SIMPLE_GIT_HOOKS=1 git push` bypasses them. Prefer that to `--no-verify`, so the intent is
obvious in the shell history.

## Known gaps

What is **not** built. Each item is traceable to code or to behaviour you can see in the app.

- **Password reset.** `/forgot-password` exists but is only an information page saying resets are
  handled by an administrator — and the Users screen has no way to set or reset a password (editing
  a user refuses one). A user who forgets their password currently cannot get back in without
  direct database access.
- **Prescription capture.** Schedule H / H1 / X prescription and doctor details are not recorded
  (`client/src/pages/settings/GeneralTab.jsx`).
- **Notification channels.** The bell is in-app. `email` is a real channel only for the near-expiry
  digest. There is no WhatsApp (`server/services/dashboard.service.js`).
- **The email channel cannot be set from Settings.** The API accepts `channel: "email"` for the near-expiry
  notification, but Common Settings → Notifications has only an on/off toggle (and still describes
  notifications as in-app only), so switching the digest on currently means a `PATCH /api/settings/general`.
  Details in [docs/modules.md](docs/modules.md#scheduled-jobs--near-expiry-email-digest)
  (`client/src/pages/settings/GeneralTab.jsx`).
- **Per-user notification preferences.** The digest goes to the organization owner's address only.
  A per-user opt-in was deliberately not added without a Settings screen to set it.
- **Changing a login email.** Needs email verification (`client/src/pages/settings/OrganizationTab.jsx`).
- **Branch scope on custom roles is a label.** It records intent and is shown as such in the UI, but
  nothing reads it when answering a query. Branch filtering that existed before roles became
  editable (transfers, analytics) is still enforced.
- **Self-service signup** does not exist, by design. Pharmacies are onboarded at `/platform`.

## Security notes

- Passwords are bcrypt-hashed. Tokens are httpOnly cookies with a double-submit CSRF token.
- Access tokens carry identity only — **never permissions**, which are read live on each request.
- Uploads live outside anything the web server serves and are readable only through an
  authenticated endpoint; a file's type is decided by its bytes, not its name.
- `StockMovement` and `AuditLog` are append-only; corrections are new opposite entries.
- Never commit `.env` files — they are git-ignored.

## Deploying on Vercel

The app can run entirely on Vercel (static client plus the API as one Function). The steps, the environment variables, and what behaves differently there (4 MB upload cap, Blob storage, cron-driven digest) are in [docs/deploy-vercel.md](docs/deploy-vercel.md).
