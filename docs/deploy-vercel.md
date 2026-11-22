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

## Node version

The root `package.json` pins `"engines": { "node": "26.x" }`, the major the project's Node.js setting runs. A range such as `>=20` makes Vercel print "will automatically upgrade when a new major Node.js Version is released" on every build, because it would then move to a new major without anyone choosing to. To move up, change this line and the project's Node.js Version setting together, deploy, and check `/api/health`. Developing on a different major only prints an `EBADENGINE` warning from `npm install`; it does not stop anything. (`server/package.json` keeps `>=20` as the lowest Node the server code needs; Vercel does not read it.)

## Caching

- **`/assets/*` is cached for a year and marked `immutable`.** Everything the build writes there has a content hash in its name (`index-BONJ0TKq.js`), so a changed file is a new URL and a cached one can never be stale. The page itself (`/`, `/login`, ...) and anything copied from `client/public` (`favicon.svg`, `logo/`, `og-image.png`) are not hashed and keep revalidating on every request.
- **Known quirk: Vercel also puts that header on a 404 under `/assets`.** A browser that asked for a chunk the current deployment no longer has can therefore keep a stored 404 for a year, which would matter if the same file reappears (a rollback, or a revert that rebuilds an identical hash). `client/src/utils/chunkReload.js` handles it: on a failed chunk it re-fetches that one address with `cache: 'reload'`, which replaces the stored answer, and then reloads the page once. I tried the Vite framework preset instead (`"framework": "vite"`); it adds no cache header at all, so it is not an alternative. If you ever see a lazy screen fail permanently in one browser after a rollback, a hard refresh clears it.
- **So an image that should be cached forever must be imported by the code, not dropped in `client/public`.** The landing photographs live in `client/src/assets/landing/` (AVIF first, WebP behind it) for that reason. `src/deploy-config.test.js` fails if `client/public/assets` appears or the photographs move.
- Open Graph tags in `client/index.html` use the address in `APP_URL` at build time (`__SITE_URL__`), so link previews follow a custom domain without an edit. Where `APP_URL` is not set (local builds, Preview) they stay root-relative and crawlers ignore them.

## Preview deployments

**Preview deployments are not expected to work as a full app, and that is deliberate.** Production variables are scoped to Production only, so a Preview build has no database, no secrets and no `CLIENT_ORIGIN`; the pages load but `/api` does not start. Previews are also behind Vercel Authentication, so only team members can open one.

Giving Preview "safe" values would mean a separate Atlas database with its own credentials and a mail sandbox, and a different `CLIENT_ORIGIN` for every deployment (each Preview has its own address). Pointing Preview at the production database instead would let any branch push read and write real data. If you want working previews, set up that separate database first, then add Preview-scoped values for `MONGODB_URI`, `JWT_SECRET`, `CRON_SECRET`, `APP_URL`, and `CLIENT_ORIGIN` set to the Preview address.

Note that connecting the Blob store adds `BLOB_STORE_ID` and `BLOB_WEBHOOK_PUBLIC_KEY` to **Preview as well as Production**. A Preview that did get a database would therefore write uploads into the production store. Untick Preview in the store's connection settings before enabling real previews.

## `BLOB_WEBHOOK_PUBLIC_KEY`

Vercel adds this when the Blob store is connected; it is not something to set by hand. It is only read by the SDK when verifying the callback of a **client-side (presigned) upload**. This app uploads from the server (`server/services/storage/blobStorage.js`: `put`, `get`, `del`, `list`), has no client-upload route and registers no callback, so there is no webhook to verify and nothing is unprotected. It is a public key, not a secret. Leave it. If direct-to-Blob uploads are added later (to lift the 4 MB cap), their callback route must verify the signature with it (`handleUpload` does so automatically).

## Rolling back

Promote the previous deployment in Vercel (Deployments → ⋯ → Promote). No data migration is involved.
