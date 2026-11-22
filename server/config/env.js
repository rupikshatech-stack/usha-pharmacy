import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeEnv = process.env.NODE_ENV || 'development';

// Environment-specific file first (e.g. .env.production), then the shared .env.
// dotenv never overrides a variable that is already set, so real environment variables win.
dotenv.config({ path: path.join(root, `.env.${nodeEnv}`), quiet: true });
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const emptyToUndefined = (v) => (v === '' ? undefined : v);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: z.preprocess(emptyToUndefined, z.string().regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://').optional()),
    JWT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32, 'must be at least 32 characters').optional()),
    // One or more allowed browser origins, comma separated.
    CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

    // --- Hosting on Vercel (see docs/deploy-vercel.md). Set in the Vercel project, never in a file. ---
    // Vercel sets VERCEL itself; it is what tells this schema the app is running there.
    VERCEL: z.preprocess(emptyToUndefined, z.string().optional()),
    // Vercel Cron sends this as `Authorization: Bearer <CRON_SECRET>` to /api/cron/expiry-alerts; the route refuses
    // every other caller. No default: a guessable secret would be worse than none.
    CRON_SECRET: z.preprocess(emptyToUndefined, z.string().min(16, 'must be at least 16 characters').optional()),
    // Credentials for the private Vercel Blob store that holds uploads (the disk is ephemeral on Vercel). Either one
    // works: BLOB_STORE_ID is added by connecting the store to the project, BLOB_READ_WRITE_TOKEN is the older token.
    // Read by the storage layer straight from the environment; they are validated here so a missing one fails at boot.
    BLOB_READ_WRITE_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
    BLOB_STORE_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    // The public address of the web app, used for the links inside emails (the server has no other way to know it).
    // No default: the code falls back to http://localhost:5173 when it is missing, which put dead links in real mail.
    APP_URL: z.preprocess(emptyToUndefined, z.url('must be a full address, such as https://pharmacy.example.com').optional()),

    // --- Outgoing mail (optional: with no SMTP_HOST the digest is only written to the log) ---
    // Read by services/email straight from the environment; validated here so a half-configured setup fails at boot
    // and names the variable, rather than failing at 01:00 when the first digest tries to go out.
    SMTP_HOST: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
    SMTP_SECURE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
    SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
    SMTP_PASS: z.preprocess(emptyToUndefined, z.string().optional()),
    MAIL_FROM: z.preprocess(emptyToUndefined, z.string().trim().optional()),

    // --- Authentication / sessions ---
    ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    SESSION_HOURS: z.coerce.number().int().min(1).max(72).default(12), // lifetime without "remember me"
    REMEMBER_ME_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    COOKIE_SECURE: z.preprocess((v) => (v === undefined || v === '' ? undefined : v === 'true'), z.boolean().optional()),
    MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(20).default(5),
    LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    // --- Initial administrator (used only by `npm run seed`) ---
    ADMIN_ORG_NAME: z.string().trim().min(1).default('Usha Pharmacy'),
    ADMIN_NAME: z.string().trim().min(1).default('Usha Admin'),
    // A placeholder, matching .env.example: a real address does not belong in the source. Every install sets
    // ADMIN_EMAIL in its own .env, so this default is only ever reached by a seed run that forgot to.
    ADMIN_EMAIL: z.string().trim().toLowerCase().email().default('admin@example.com'),
    ADMIN_INITIAL_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),
    ADMIN_REQUIRE_PASSWORD_CHANGE: z.preprocess((v) => v === 'true', z.boolean()),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production') {
      if (!v.MONGODB_URI) ctx.addIssue({ code: 'custom', path: ['MONGODB_URI'], message: 'is required in production' });
      if (!v.JWT_SECRET) ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'is required in production' });
    }
    // Only on Vercel: there the disk is ephemeral (uploads would vanish) and Vercel Cron is the only thing that can
    // run the nightly digest. A production server of your own keeps files on disk and runs the digest from its
    // scheduler (scripts/run-expiry-alerts.js, which loads this same schema), so it needs neither.
    if (v.NODE_ENV === 'production' && v.VERCEL) {
      if (!v.CRON_SECRET) ctx.addIssue({ code: 'custom', path: ['CRON_SECRET'], message: 'is required in production on Vercel' });
      if (!v.BLOB_STORE_ID && !v.BLOB_READ_WRITE_TOKEN) {
        ctx.addIssue({ code: 'custom', path: ['BLOB_READ_WRITE_TOKEN'], message: 'or BLOB_STORE_ID is required in production on Vercel (connect a private Blob store)' });
      }
      if (!v.APP_URL) ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'is required in production on Vercel (links in emails would point at localhost)' });
      else if (!v.APP_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'must be an https:// address in production' });
    }
    // With a mail server configured, the sender must be a real address: the code otherwise sends from
    // no-reply@localhost, which providers reject, and the failure would only show when a digest is due.
    if (v.NODE_ENV === 'production' && v.SMTP_HOST && !v.MAIL_FROM) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'is required in production when SMTP_HOST is set' });
    }
    if (v.COOKIE_SAME_SITE === 'none' && v.COOKIE_SECURE === false) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'must not be false when COOKIE_SAME_SITE=none' });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  // Print variable names and problems only, never values.
  console.error(`\nInvalid environment configuration:\n${lines.join('\n')}\n\nSee server/.env.example.\n`);
  process.exit(1);
}

const e = parsed.data;

export const env = {
  nodeEnv: e.NODE_ENV,
  isProd: e.NODE_ENV === 'production',
  isTest: e.NODE_ENV === 'test',
  port: e.PORT,
  mongoUri: e.MONGODB_URI || '',
  // Without a configured secret (development/test only) use a random one: sessions reset on restart.
  jwtSecret: e.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  clientOrigins: e.CLIENT_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  auth: {
    accessTokenSeconds: e.ACCESS_TOKEN_MINUTES * 60,
    sessionMs: e.SESSION_HOURS * 3600 * 1000,
    rememberMs: e.REMEMBER_ME_DAYS * 24 * 3600 * 1000,
    maxFailedLogins: e.MAX_FAILED_LOGINS,
    lockoutMs: e.LOCKOUT_MINUTES * 60 * 1000,
    cookie: {
      sameSite: e.COOKIE_SAME_SITE,
      // Secure cookies in production (and whenever SameSite=None, which browsers require).
      secure: e.COOKIE_SECURE ?? (e.NODE_ENV === 'production' || e.COOKIE_SAME_SITE === 'none'),
    },
  },
  admin: {
    orgName: e.ADMIN_ORG_NAME,
    name: e.ADMIN_NAME,
    email: e.ADMIN_EMAIL,
    initialPassword: e.ADMIN_INITIAL_PASSWORD || '',
    requirePasswordChange: e.ADMIN_REQUIRE_PASSWORD_CHANGE,
  },
  root,
};
