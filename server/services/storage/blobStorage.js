import { put, get, del, list } from '@vercel/blob';

/**
 * Vercel Blob implementation of the storage interface (put / get / list / remove), for hosts with no persistent disk.
 *
 * The store MUST be a private one: a private blob has no public URL and can only be read through `get` with the
 * store's credentials, so every file still goes back to a person only via our authenticated endpoints, exactly as
 * with the local-disk storage. Keys are made by the server (never from user input) and are used as the blob pathname.
 * Credentials are picked up by the SDK from the environment (BLOB_STORE_ID with OIDC on Vercel, or BLOB_READ_WRITE_TOKEN).
 */
const ACCESS = 'private';

const safeKey = (key) => {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.split('/').includes('..')) throw new Error('Refusing a storage key outside the store.');
  return key;
};

const streamToBuffer = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());

export const blobStorage = {
  async put(key, buffer) {
    await put(safeKey(key), buffer, { access: ACCESS, addRandomSuffix: false, allowOverwrite: false }); // never overwrite
    return key;
  },
  async get(key) {
    const file = await get(safeKey(key), { access: ACCESS });
    if (!file || !file.stream) {
      const e = new Error('File not found.');
      e.code = 'ENOENT'; // the same signal the local-disk storage gives, so callers treat both alike
      throw e;
    }
    return streamToBuffer(file.stream);
  },
  async list(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await list({ prefix: safeKey(prefix).replace(/\/?$/, '/'), cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ key: b.pathname, size: b.size, modifiedAt: new Date(b.uploadedAt) });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
  async remove(key) {
    await del(safeKey(key)); // deleting what is already gone is not an error
  },
};

export const blobConfigured = () => Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
