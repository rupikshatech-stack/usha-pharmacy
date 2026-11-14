import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import mongoose from 'mongoose';
import { env } from './env.js';
import { useCachedMongoBinary } from './mongoBinary.js';

const DEV_PORT = 27018;
const DEV_DB = 'usha_pharmacy';
let memory = null;

const portInUse = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

/**
 * Connects to MongoDB. Uses MONGODB_URI when set (Atlas / hosted replica set). Otherwise, outside
 * production, runs a local single-node replica set (required for transactions) whose data lives in
 * server/.data. If a previous dev run left that database up (e.g. after an auto-restart), it is reused.
 */
export async function connectDb() {
  let uri = env.mongoUri;

  if (!uri) {
    if (env.isProd) throw new Error('MONGODB_URI must be set in production');

    if (await portInUse(DEV_PORT)) {
      uri = `mongodb://127.0.0.1:${DEV_PORT}/${DEV_DB}?replicaSet=testset`;
      console.log('[db] Reusing the running development database');
    } else {
      const dbPath = path.join(env.root, '.data', 'db');
      fs.mkdirSync(dbPath, { recursive: true });
      useCachedMongoBinary();
      const { MongoMemoryReplSet } = await import('mongodb-memory-server');
      memory = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger', dbName: DEV_DB },
        instanceOpts: [{ dbPath, port: DEV_PORT }],
      });
      uri = memory.getUri(DEV_DB);
      console.log('[db] Started embedded MongoDB replica set (development only)');
    }
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('[db] Connected');
}

export async function disconnectDb() {
  await mongoose.disconnect();
  if (memory) await memory.stop();
}

export const dbState = () => ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
