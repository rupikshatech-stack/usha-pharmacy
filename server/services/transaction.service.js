import mongoose from 'mongoose';

/** Runs fn(session) inside a MongoDB transaction: commits atomically or rolls everything back. */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
