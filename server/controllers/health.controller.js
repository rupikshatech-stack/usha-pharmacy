import { dbState } from '../config/db.js';
import { env } from '../config/env.js';

/** Liveness + readiness probe. Returns 503 when the database isn't connected. */
export function health(_req, res) {
  const db = dbState();
  res.status(db === 'connected' ? 200 : 503).json({
    success: db === 'connected',
    status: db === 'connected' ? 'ok' : 'degraded',
    environment: env.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    database: db,
    timestamp: new Date().toISOString(),
  });
}
