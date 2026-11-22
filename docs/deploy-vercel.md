# Deploying on Vercel

The web app is served as static files and the API runs as **one Vercel Function** (`api/index.js`, which wraps the same Express app used everywhere else). `vercel.json` sends `/api/*` to that function and every other path to the app, so the browser sees a single origin — cookies and CSRF work exactly as in development, and there is no CORS to configure.

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
   | `CLIENT_ORIGIN` and `APP_URL` | `https://<your-domain>` |
   | `CRON_SECRET` | **required**; 16+ random characters. Vercel sends it to the cron route as `Authorization: Bearer <CRON_SECRET>`. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
   | `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` | **required**; added by connecting the Blob store (step 1). Not needed off Vercel |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | your mail provider — without `SMTP_HOST` the digest is only logged |
   | `GOOGLE_CLOUD_PROJECT_ID`, `GOOGLE_DOCUMENT_AI_LOCATION`, `GOOGLE_DOCUMENT_AI_PROCESSOR_ID`, `GOOGLE_CREDENTIALS_JSON` | invoice reading; the last one is the service-account key's JSON itself |
   | AI extraction keys | as in `server/.env.example` |

   Never put these in a file in the repository.
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
