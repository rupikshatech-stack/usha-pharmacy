/**
 * What an uploaded image really is, and what it may be called. A name and a Content-Type header are both things a
 * caller can simply assert, so the type is decided by the file's own first bytes — a PDF, a GIF, an SVG or a program
 * renamed `.jpg` is not an image here, whatever it claims.
 *
 * Used by every upload in the system (credit payment screenshots, product photos) so there is one rule, not several.
 */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/** The file's real type from its first bytes, or null when it is not an image we accept. */
export function sniffImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Documents, which are images plus PDF. A scanned drug licence arrives as either, and the rule is the same one: the
 * type is decided by the file's own first bytes, never by its name or the Content-Type header a caller asserts.
 *
 * SVG is deliberately absent from both lists. An SVG is a script-bearing document, not a picture: accepting one
 * would mean sanitising it before it could ever be shown, and a sanitiser we have not got is not a feature.
 */
export const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];
export const DOCUMENT_EXT = { ...IMAGE_EXT, 'application/pdf': '.pdf' };

/** The real type of an uploaded document — an image, or a PDF — or null when it is neither. */
export function sniffDocument(b) {
  const image = sniffImage(b);
  if (image) return image;
  // %PDF- : the header every PDF starts with.
  if (Buffer.isBuffer(b) && b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** A file name someone typed, made safe to keep and to show (no paths, no control characters, never empty). */
export function cleanFileName(name, fallback = 'image') {
  const base = String(name || fallback)
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .trim()
    .slice(0, 150);
  return base || fallback;
}
