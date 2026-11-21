/**
 * Vercel rejects any request body over 4.5 MB before it reaches the application, so on Vercel an upload limit
 * above 4 MB would promise something the platform cannot deliver (the user would see a bare 413 instead of the
 * app's own message). Everywhere else the configured limit is used unchanged.
 */
export const PLATFORM_UPLOAD_CAP_BYTES = 4 * 1024 * 1024;
export const capUpload = (bytes) => (process.env.VERCEL ? Math.min(bytes, PLATFORM_UPLOAD_CAP_BYTES) : bytes);
