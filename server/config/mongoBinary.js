import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';

/**
 * mongodb-memory-server caches the ~780 MB MongoDB binary under server/node_modules/.cache after the
 * first download. Point it at that file explicitly so it is never downloaded again, whichever
 * directory the process is started from.
 */
export function useCachedMongoBinary() {
  if (process.env.MONGOMS_SYSTEM_BINARY) return;
  const dir = path.join(env.root, 'node_modules', '.cache', 'mongodb-memory-server');
  /**
   * Only an actual executable will do. The cache directory accumulates other things beside the binary — an `.md5`
   * beside it, and a `.mdmp` crash dump whenever mongod dies (which it does when the disk fills). Those sort BEFORE
   * the `.exe`, so matching on the name prefix alone would hand the library a zero-byte crash dump and every test
   * would fail with "Couldn't find a version from system binary output". An empty file is rejected too: a download
   * killed half way through leaves one behind.
   */
  const executable = (f) => /^mongod-[^/\\]*(\.exe)?$/.test(f) && !/\.(md5|mdmp|downloading|lock|tmp)$/.test(f) && (process.platform === 'win32' ? f.endsWith('.exe') : !path.extname(f));
  try {
    const bin = fs
      .readdirSync(dir)
      .filter(executable)
      .map((f) => path.join(dir, f))
      .find((p) => fs.statSync(p).size > 0);
    if (bin) process.env.MONGOMS_SYSTEM_BINARY = bin;
  } catch {
    /* nothing cached yet — the library will download it once */
  }
}
