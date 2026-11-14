import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { IMAGE_EXT, IMAGE_TYPES, sniffImage } from '../utils/imageFile.js';
import { getStorage } from './storage/index.js';

/**
 * Photographs of products. A picture is stored like every other upload in this system: under a name the SERVER makes,
 * outside anything the web server serves, and read back only through an authenticated endpoint that belongs to the same
 * organization. The medicine record keeps the address of the picture, never the bytes.
 *
 *   PRODUCT_IMAGE_MAX_MB   largest picture (default 5)
 */
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const maxBytes = () => Math.round(num(process.env.PRODUCT_IMAGE_MAX_MB, 5) * 1024 * 1024);
export { IMAGE_TYPES };

const fail = (status, message, code, details) => new ApiError(status, message, details, code);
const FILE = /^[a-f0-9]{24}\.(jpg|png|webp)$/i; // exactly what `upload` produces, and nothing else

/** Stores one picture and returns the address to keep on the medicine. */
export async function uploadProductImage(req, { buffer, contentType }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail(400, 'Choose an image to upload.', 'IMAGE_MISSING', [{ path: 'image', message: 'Choose an image' }]);
  if (buffer.length > maxBytes()) throw fail(413, `The image is larger than ${maxBytes() / 1048576} MB.`, 'IMAGE_TOO_LARGE', [{ path: 'image', message: `Use a file up to ${maxBytes() / 1048576} MB` }]);
  const real = sniffImage(buffer);
  if (!real) throw fail(415, 'The image must be a JPG, JPEG, PNG or WEBP file.', 'IMAGE_UNSUPPORTED_TYPE', [{ path: 'image', message: 'Use a JPG, PNG or WEBP image' }]);
  if (contentType && contentType !== real) throw fail(400, `The file says it is ${contentType} but its contents are ${real}.`, 'IMAGE_TYPE_MISMATCH', [{ path: 'image', message: 'The file is not what it claims to be' }]);

  const name = `${new mongoose.Types.ObjectId()}${IMAGE_EXT[real]}`; // the server names it: nothing a caller typed reaches the disk
  await getStorage().put(`${req.orgId}/products/${name}`, buffer);
  return {
    url: `/api/inventory/images/${name}`, // what goes in the medicine's `image` field
    fileName: name,
    mimeType: real,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

/** Reads a picture back, for this organization only. A name that is not one we made is simply not found. */
export async function getProductImage(req, fileName) {
  if (!FILE.test(String(fileName || ''))) throw fail(404, 'Image not found', 'NOT_FOUND');
  const type = fileName.toLowerCase().endsWith('.png') ? 'image/png' : fileName.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  try {
    return { buffer: await getStorage().get(`${req.orgId}/products/${fileName}`), mimeType: type };
  } catch {
    throw fail(404, 'Image not found', 'NOT_FOUND'); // another organization's picture is simply not there
  }
}
