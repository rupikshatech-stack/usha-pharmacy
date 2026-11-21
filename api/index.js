// Vercel entry point: the whole Express API as one Function. vercel.json rewrites /api/* here.
// The connection is cached across invocations of a warm instance (connectDb is idempotent and shares one attempt).
import { connectDb } from '../server/config/db.js';
import { createApp } from '../server/app.js';

const app = createApp();

export default async function handler(req, res) {
  try {
    await connectDb();
  } catch (e) {
    console.error('[api] database connection failed:', e.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, message: 'The service is temporarily unavailable.' }));
  }
  return app(req, res);
}
