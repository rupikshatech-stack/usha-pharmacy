# Deploying on Vercel

The web app is served as static files and the API runs as **one Vercel Function** (`api/index.js`, which wraps the same Express app used everywhere else). `vercel.json` sends `/api/*` to that function and every other path to the app, so the browser sees a single origin and cookies and CSRF work exactly as in development. There is no cross-site setup, but the API still checks every request's `Origin` header against `CLIENT_ORIGIN` (see [CLIENT_ORIGIN](#client_origin-must-match-the-address-people-type)), so that variable **must** be set.

## Before you start

| You need | Why |
|---|---|
| A **Vercel Pro** team (or higher) | Hobby is for personal, non-commercial use; it also limits cron to once a day. |
| A **MongoDB Atlas** cluster | The app uses transactions, so it needs a replica set (every Atlas cluster is one). Allow Vercel to connect (Network Access: `0.0.0.0/0`, protected by a strong database user, unless you use a private link). |
| This repo imported into Vercel | Vercel → Add New → Project → pick `usha-pharmacy`. Leave the framework preset as "Other"; `vercel.json` supplies the commands. |

## Project setup

1. **Storage → Create a Blob store, access = Private.** Connect it to the project. Connecting adds the store's credential to the project's environment automatically, as `BLOB_STORE_ID` (or, for a token-based store, `BLOB_READ_WRITE_TOKEN`); the app accepts either. Private matters: files must only be readable through the app's own authenticated endpoints. The access mode cannot be changed later.

   **One of the two is required on Vercel.** `server/config/env.js` checks at start-up and the function refuses to boot without it, rather than losing uploads later on the ephemeral disk. Set it (and `CRON_SECRET`, below) **before** deploying this version. Confirm with `vercel env ls`.
2. **Environment variables** (Project → Settings → Environment Variables, Production):

   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | the Atlas connection string |
   | `JWT_SECRET` | 32+ random characters |
   | `CLIENT_ORIGIN` | **required**; the exact address(es) people open the app at, e.g. `https://pharmacy.example.com`. Comma-separate several. See below |
   | `APP_URL` | **required**; the public address, used for links inside emails (the digest). Same address, `https://<your-domain>` |
   | `CRON_SECRET` | **required**; 16+ random characters. Vercel sends it to the cron route as `Authorization: Bearer <CRON_SECRET>`. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
   | `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` | **required**; added by connecting the Blob store (step 1). Not needed off Vercel |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | your mail provider — without `SMTP_HOST` the digest is only logged. Once `SMTP_HOST` is set, `MAIL_FROM` (a real sender address) is **required**: the function refuses to start without it rather than sending from `no-reply@localhost` |
   | `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_DOCUMENT_AI_LOCATION`, `GOOGLE_DOCUMENT_AI_PROCESSOR_ID`, `GOOGLE_CREDENTIALS_JSON` | invoice reading; the last one is the service-account key's JSON itself |
   | AI extraction keys | as in `server/.env.example` |

   Never put these in a file in the repository.

### `CLIENT_ORIGIN` must match the address people type

The browser and the API share one address on Vercel, so there is nothing to configure for cross-site requests. **The server still checks, on every request that carries an `Origin` header, that the origin is in `CLIENT_ORIGIN`.** Browsers send that header on every sign-in, save and delete (every `POST`, `PUT`, `PATCH` and `DELETE`), even to the same site. If the origin is not listed, the request is refused with `403 Origin not allowed by CORS` and the person sees that message on the sign-in form.

- It defaults to `http://localhost:5173` when unset. Left unset on Vercel, **nobody can sign in**, while the pages and `GET` requests look completely healthy. This is what happened on the first deploy.
- Set it to the **origin**: scheme and host (and port, if any). No path and no trailing slash: `https://pharmacy.example.com`, not `https://pharmacy.example.com/`. The comparison is an exact string match.
- List **every** address people use, comma-separated. The `*.vercel.app` address and a custom domain are different origins, as are `www.` and the bare domain: `https://pharmacy.example.com,https://www.pharmacy.example.com`.
- Adding a custom domain later means adding it here too, and redeploying: environment changes apply only to new deployments.
- Preview deployments get their own `*.vercel.app` address, which is not in the list, so signing in on a preview fails unless you add that address. This is by design.
- Requests with no `Origin` header (`curl`, health checks, Vercel Cron) are not affected.

To check it from a terminal: `curl -s -o /dev/null -w "%{http_code}
" -X OPTIONS -H "Origin: https://<your-domain>" -H "Access-Control-Request-Method: POST" https://<your-domain>/api/auth/login` should print `204`, and the same request with `Origin: https://not-listed.example` should print `403`.
3. **First deploy**, then prepare the database **from your own machine**, pointing at Atlas (not from Vercel): put `MONGODB_URI` in `server/.env` temporarily, then run `npm run migrate`, `npm run seed` and `node server/scripts/create-platform-admin.js`, and remove the line again.

## What differs from running it yourself

- **Uploads are capped at 4 MB** (the platform rejects request bodies over 4.5 MB before the app sees them). Invoices were 10 MB, screenshots/images/licence scans 5 MB. Larger files need a direct-to-storage upload, which is not built.
- **Files live in Vercel Blob**, not `server/uploads`. Existing local uploads are not migrated.
- **Invoice reading runs after the response** (`waitUntil`), within the function's 300 s limit.
- **The near-expiry digest** is called daily at 01:00 UTC (06:30 IST) by Vercel Cron on `GET /api/cron/expiry-alerts`. It refuses to run without `CRON_SECRET`. The once-a-day claim still prevents duplicates.
- **Rate limits are per instance**, not global: they slow abuse but are weaker than on a single server.
- `scripts/cleanup-uploads.js` only knows the local disk; it does not clean Blob yet.

## Rolling back

Promote the previous deployment in Vercel (Deployments → ⋯ → Promote). No data migration is involved.
