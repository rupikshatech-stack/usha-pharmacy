import { Organization } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { audit } from '../services/audit.service.js';
import { assertFiscalYearUnlocked, assertTimezoneUnlocked } from '../services/settings.service.js';

const publicOrg = (o) => ({
  id: o._id,
  name: o.name,
  slug: o.slug,
  email: o.email,
  phone: o.phone,
  address: o.address,
  gstin: o.gstin,
  logo: o.logo,
  status: o.status,
  timezone: o.timezone,
  settings: o.settings,
  createdAt: o.createdAt,
  updatedAt: o.updatedAt,
});

/** The caller's own organization — taken from the verified tenant context, never from the request. */
export async function get(req, res) {
  res.json({ success: true, data: publicOrg(req.tenant.organization) });
}

export async function update(req, res) {
  // The financial-year start has two doors - this one and Common Settings - and both must honour the same lock.
  await assertFiscalYearUnlocked(req.tenant.organization, req.body.settings?.fiscalYearStartMonth);
  // ...and the timezone has three doors (this one, PATCH /settings/organization and PATCH /settings/general). All three
  // go through the same function, so there is one lock and no way round it.
  await assertTimezoneUnlocked(req.tenant.organization, req.body.timezone);
  // Flatten the address so a partial update doesn't wipe the other address fields.
  const { address, settings, ...rest } = req.body;
  const set = { ...rest };
  for (const [k, v] of Object.entries(address || {})) if (v !== undefined) set[`address.${k}`] = v;
  for (const [k, v] of Object.entries(settings || {})) if (v !== undefined) set[`settings.${k}`] = v;

  let org;
  try {
    org = await Organization.findOneAndUpdate({ _id: req.tenant.organizationId }, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
  } catch (e) {
    if (e.code === 11000) throw new ApiError(409, 'That GSTIN is already registered to another organization.', undefined, 'DUPLICATE');
    throw e;
  }
  await audit(req, { action: 'ORGANIZATION_UPDATE', entity: 'Organization', entityId: org._id, message: 'Organization profile updated' });
  res.json({ success: true, data: publicOrg(org) });
}
