import { env } from './config/env.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';

// The first administrator is created separately with `npm run seed`.
await connectDb();

const server = createApp().listen(env.port, () => {
  console.log(`[api] ${env.nodeEnv} server listening on http://localhost:${env.port}`);
});

let closing = false;
const shutdown = async (signal) => {
  if (closing) return;
  closing = true;
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await disconnectDb();
  process.exit(0);
};
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => shutdown(s)));
