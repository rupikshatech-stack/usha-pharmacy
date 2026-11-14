import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where uploaded files live. This is the local-disk implementation; the application only uses put / get / remove, so a cloud store
 * (S3, Azure Blob, GCS …) can replace it without touching anything else.
 *
 * Safety: files are kept OUTSIDE anything the web server serves; they can only be read back through an authenticated endpoint. A file's
 * name on disk is made by the server (organization id + a random upload id + a fixed extension), never from what the user typed, and every
 * path is checked to stay inside the upload folder.
 *   UPLOAD_DIR – the folder (default: server/uploads). Read on every call.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = () => path.resolve(process.env.UPLOAD_DIR?.trim() || path.join(here, '..', '..', 'uploads'));

function resolveInside(key) {
  const base = root();
  const full = path.resolve(base, key);
  if (!full.startsWith(base + path.sep)) throw new Error('Refusing a storage path outside the upload folder.');
  return full;
}

export const localStorage = {
  /** Stores the bytes under a server-made key and returns the key. */
  async put(key, buffer) {
    const full = resolveInside(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer, { flag: 'wx', mode: 0o600 }); // never overwrite
    return key;
  },
  async get(key) {
    return fs.readFile(resolveInside(key));
  },
  /**
   * What is stored under a prefix, with each file's age. Used to find uploads that were never attached to
   * anything — a cloud store answers the same question with a list call, which is why age comes back here rather
   * than the caller stat-ing each file itself.
   */
  async list(prefix) {
    const base = root();
    const dir = resolveInside(prefix);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return []; // nothing has ever been stored here
      throw e;
    }
    const out = [];
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) out.push({ key: path.relative(base, full).split(path.sep).join('/'), size: stat.size, modifiedAt: stat.mtime });
      } catch {
        /* a file that vanished between the listing and the stat is simply not there */
      }
    }
    return out;
  },

  /** Removes a file; a file that is already gone is fine. */
  async remove(key) {
    try {
      await fs.unlink(resolveInside(key));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  },
};

/** The storage in use. Swap this one line (or make it depend on a setting) to move uploads to the cloud. */
export const getStorage = () => localStorage;
