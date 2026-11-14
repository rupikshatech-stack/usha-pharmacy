import mongoose from 'mongoose';
import { Organization } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { DOCUMENT_EXT, DOCUMENT_TYPES, IMAGE_EXT, IMAGE_TYPES, cleanFileName, sniffDocument, sniffImage } from '../utils/imageFile.js';
import { getStorage } from './storage/index.js';
import { audit } from './audit.service.js';

/**
 * The two kinds of file a Settings screen takes: the store logo, and a scanned drug licence.
 *
 * Both follow the rule the rest of this system already uses for uploads — the bytes decide what the file is, the
 * SERVER decides what it is called, it is written outside anything the web server serves, and it is read back only
 * through an authenticated endpoint belonging to the same organization. Nothing a caller typed ever reaches the
 * disk as a path.
 *
 * SVG IS NOT ACCEPTED, for either. An SVG can carry script, so "display the customer's logo" would become "run the
 * customer's code in everybody's browser". Accepting it safely needs a sanitiser this project does not have, and a
 * logo is a picture — PNG, JPG and WebP are pictures.
 *
 *   SETTINGS_LOGO_MAX_MB       largest logo (default 2)
 *   SETTINGS_DOCUMENT_MAX_MB   largest licence scan (default 5)
 */
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const logoMaxBytes = () => Math.round(num(process.env.SETTINGS_LOGO_MAX_MB, 2) * 1024 * 1024);
export const documentMaxBytes = () => Math.round(num(process.env.SETTINGS_DOCUMENT_MAX_MB, 5) * 1024 * 1024);
export { IMAGE_TYPES, DOCUMENT_TYPES };

const fail = (status, message, code, details) => new ApiError(status, message, details, code);
const LOGO_FILE = /^[a-f0-9]{24}\.(jpg|png|webp)$/i;
const DOC_FILE = /^[a-f0-9]{24}\.(jpg|png|webp|pdf)$/i;
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

/** Where a file of each kind lives, per organization. The key is built here and never comes from a request. */
const logoKey = (orgId, name) => `${orgId}/branding/${name}`;
const docKey = (orgId, name) => `${orgId}/licenses/${name}`;

/** The type a file really is, checked against what it claimed to be. */
function realType(buffer, contentType, { documents = false } = {}) {
  const sniff = documents ? sniffDocument : sniffImage;
  const allowed = documents ? DOCUMENT_TYPES : IMAGE_TYPES;
  const kind = documents ? 'a JPG, PNG, WEBP or PDF file' : 'a JPG, PNG or WEBP image';
  const real = sniff(buffer);
  if (!real) {
    throw fail(415, `That file is not ${kind}. Its contents are not any format we accept — a file renamed is still the file it was.`, 'FILE_UNSUPPORTED_TYPE', [
      { path: 'file', message: `Use ${kind}` },
    ]);
  }
  if (contentType && allowed.includes(contentType) && contentType !== real) {
    throw fail(400, `The file says it is ${contentType} but its contents are ${real}.`, 'FILE_TYPE_MISMATCH', [{ path: 'file', message: 'The file is not what it claims to be' }]);
  }
  return real;
}

function checkSize(buffer, max, what) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw fail(400, `Choose ${what} to upload.`, 'FILE_MISSING', [{ path: 'file', message: 'Choose a file' }]);
  if (buffer.length > max) {
    throw fail(413, `That file is ${mb(buffer.length)} MB; the limit is ${mb(max)} MB.`, 'FILE_TOO_LARGE', [{ path: 'file', message: `Use a file up to ${mb(max)} MB` }]);
  }
}

/* ------------------------------------------------------------------ the logo */

/**
 * Replaces the store logo. The new file is written first and the old one removed only after the organization points
 * at the new one — so a failure half way through leaves the old logo working rather than no logo at all.
 */
export async function uploadLogo(req, { buffer, contentType, fileName }) {
  checkSize(buffer, logoMaxBytes(), 'a logo');
  const real = realType(buffer, contentType);

  const name = `${new mongoose.Types.ObjectId()}${IMAGE_EXT[real]}`;
  await getStorage().put(logoKey(req.orgId, name), buffer);

  const previous = req.tenant.organization?.logo || '';
  const url = `/api/settings/logo/${name}`;
  await Organization.updateOne({ _id: req.orgId }, { $set: { logo: url, 'settings.updatedAt': new Date(), 'settings.updatedBy': req.user._id, 'settings.updatedByName': req.user.name } });

  // The file that is no longer referenced goes, so replacing a logo ten times does not leave ten files behind.
  await removeIfOurs(req.orgId, previous);

  await audit(req, {
    action: 'SETTINGS_LOGO_UPLOAD',
    entity: 'Organization',
    entityId: req.orgId,
    message: `Store logo updated (${cleanFileName(fileName)}, ${real}, ${mb(buffer.length)} MB)`,
    meta: { changes: [{ field: 'logo', from: previous || null, to: url }], mimeType: real, size: buffer.length },
  });
  return { url, fileName: name, mimeType: real, size: buffer.length };
}

/** Removes the logo file this organization is pointing at, if the path is one we issued. */
async function removeIfOurs(orgId, url) {
  const name = String(url || '').split('/').pop();
  if (!LOGO_FILE.test(name)) return; // an older plain link, or nothing at all: there is no file of ours to remove
  await getStorage().remove(logoKey(orgId, name));
}

export async function deleteLogo(req) {
  const previous = req.tenant.organization?.logo || '';
  if (!previous) return { url: '' };
  await Organization.updateOne({ _id: req.orgId }, { $set: { logo: '', 'settings.updatedAt': new Date(), 'settings.updatedBy': req.user._id, 'settings.updatedByName': req.user.name } });
  await removeIfOurs(req.orgId, previous);
  await audit(req, {
    action: 'SETTINGS_LOGO_DELETE',
    entity: 'Organization',
    entityId: req.orgId,
    message: 'Store logo removed',
    meta: { changes: [{ field: 'logo', from: previous, to: '' }] },
  });
  return { url: '' };
}

/** Reads the logo back, for this organization only. A name we did not issue is simply not found. */
export async function getLogo(req, fileName) {
  if (!LOGO_FILE.test(String(fileName || ''))) throw fail(404, 'Logo not found', 'NOT_FOUND');
  const type = fileName.toLowerCase().endsWith('.png') ? 'image/png' : fileName.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  try {
    return { buffer: await getStorage().get(logoKey(req.orgId, fileName)), mimeType: type };
  } catch {
    throw fail(404, 'Logo not found', 'NOT_FOUND'); // another organization's logo is simply not there
  }
}

/* ------------------------------------------------------------------ licence documents */

/**
 * Stores a scanned licence and hands back the descriptor to put on the licence when the form is saved.
 *
 * The file is uploaded as soon as it is chosen, like every other upload in this system, so the form holds a short
 * descriptor instead of megabytes of bytes. A file whose licence is never saved is left unreferenced; the save
 * removes any licence document the new list no longer points at, which is what clears them up.
 */
export async function uploadDocument(req, { buffer, contentType, fileName }) {
  checkSize(buffer, documentMaxBytes(), 'a document');
  const real = realType(buffer, contentType, { documents: true });

  const name = `${new mongoose.Types.ObjectId()}${DOCUMENT_EXT[real]}`;
  const storageKey = docKey(req.orgId, name);
  await getStorage().put(storageKey, buffer);

  await audit(req, {
    action: 'SETTINGS_DOCUMENT_UPLOAD',
    entity: 'Organization',
    entityId: req.orgId,
    message: `Licence document uploaded (${cleanFileName(fileName)}, ${real}, ${mb(buffer.length)} MB)`,
    meta: { storageKey, mimeType: real, size: buffer.length },
  });

  return {
    // What the form sends back on the licence. The key is checked against this organization when it is saved.
    storageKey,
    url: `/api/settings/documents/${name}`,
    fileName: cleanFileName(fileName, 'licence'),
    mimeType: real,
    size: buffer.length,
  };
}

/** Reads a licence document back, for this organization only. */
export async function getDocument(req, fileName) {
  if (!DOC_FILE.test(String(fileName || ''))) throw fail(404, 'Document not found', 'NOT_FOUND');
  const lower = fileName.toLowerCase();
  const type = lower.endsWith('.pdf') ? 'application/pdf' : lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  try {
    return { buffer: await getStorage().get(docKey(req.orgId, fileName)), mimeType: type };
  } catch {
    throw fail(404, 'Document not found', 'NOT_FOUND');
  }
}

/** Whether a storage key is one this organization was given — a licence may not point at somebody else's file. */
export const ownsStorageKey = (orgId, key) => new RegExp(`^${orgId}/licenses/[a-f0-9]{24}\\.(jpg|png|webp|pdf)$`, 'i').test(String(key || ''));

/**
 * How long an upload that was never attached to anything is kept before it is swept away. A person may upload a
 * scan, go to lunch, and come back to the tab — so "unreferenced" on its own is not enough reason to delete.
 *   SETTINGS_ORPHAN_HOURS   default 24
 */
export const orphanAgeMs = () => Math.round(num(process.env.SETTINGS_ORPHAN_HOURS, 24) * 3600 * 1000);

/**
 * Removes licence scans that no licence refers to AND that are older than the grace period.
 *
 * This is for ABANDONED uploads: a file chosen in the form, uploaded straight away as every upload in this system
 * is, and then never saved — because the person pressed Discard, closed the tab, or walked away. Nothing in the
 * database ever pointed at it, so nothing but its age can tell it apart from a file somebody is still working
 * with. A file younger than the grace period is therefore left alone, however unreferenced it looks.
 *
 * It is deliberately NOT the same thing as `removeOrphanDocuments`, which deletes a file the moment its licence is
 * removed: there the reference existed and a person deleted it, which is an instruction, not an accident.
 */
export async function sweepAbandonedDocuments(orgId, licenses = [], { now = Date.now(), olderThanMs = orphanAgeMs() } = {}) {
  const referenced = new Set((licenses || []).map((l) => l?.document?.storageKey).filter(Boolean));
  const storage = getStorage();
  let removed = 0;
  let kept = 0;
  for (const file of await storage.list(`${orgId}/licenses`)) {
    if (referenced.has(file.key)) continue;
    if (now - new Date(file.modifiedAt).getTime() < olderThanMs) {
      kept += 1; // young enough that somebody may still be filling in the form it belongs to
      continue;
    }
    await storage.remove(file.key);
    removed += 1;
  }
  return { removed, keptYoung: kept };
}

/**
 * Removes licence documents the saved list no longer refers to. Called after a successful save, so a file is only
 * deleted once the record that stopped pointing at it is safely stored.
 */
export async function removeOrphanDocuments(orgId, before = [], after = []) {
  const kept = new Set(after.map((l) => l?.document?.storageKey).filter(Boolean));
  const gone = before.map((l) => l?.document?.storageKey).filter((k) => k && !kept.has(k));
  const storage = getStorage();
  for (const key of gone) {
    // Only ever a key inside this organization's own folder.
    if (ownsStorageKey(orgId, key)) await storage.remove(key);
  }
  return gone.length;
}
