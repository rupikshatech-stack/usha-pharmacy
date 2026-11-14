import { env } from './env.js';

/** CORS restricted to the configured frontend origin(s). Requests without an Origin (curl, health probes) are allowed. */
export const corsOptions = {
  credentials: true,
  origin(origin, callback) {
    if (!origin || env.clientOrigins.includes(origin)) return callback(null, true);
    const err = new Error('Origin not allowed by CORS');
    err.status = 403;
    return callback(err);
  },
};
