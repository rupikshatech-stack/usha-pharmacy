/**
 * Roles and permissions.
 *
 * SUPER_ADMIN is a reserved platform-level role (no organization). It cannot use tenant routes;
 * a separate platform area will handle it later.
 */
export const ROLES = ['SUPER_ADMIN', 'ORG_ADMIN', 'BRANCH_MANAGER', 'INVENTORY_MANAGER', 'BILLING_STAFF', 'STAFF'];

export const PERMISSIONS = [
  'inventory:read',
  'inventory:write',
  'inventory:delete',
  'transfer:view', // see transfers (implied by inventory:read)
  'transfer:create', // draft a new transfer
  'transfer:edit', // edit or delete a draft
  'transfer:submit', // send a draft on for approval / dispatch
  'transfer:manage', // umbrella: create + edit + submit + cancel (kept so existing role setups keep working)
  'transfer:cancel', // cancel a transfer that has not been fully received
  'transfer:print', // print / download the transfer document (implied by inventory:read)
  'transfer:reject', // reject a submitted transfer (implied by transfer:approve)
  'transfer:approve', // approve or reject submitted transfers
  'transfer:dispatch', // confirm that approved stock has left the source store
  'transfer:receive', // record what actually arrived at the destination store
  'billing:read',
  'billing:create',
  'orders:approve', // approve or send back a supplier order (when the organization requires approval)
  'returns:approve', // approve or reject a customer return (and restock decisions made on it)
  'returns:refund', // record the progress of a refund (processing, completed, failed)
  'reports:read',
  'audit:read',
  'users:manage',
  'settings:read',
  'settings:manage',
];

const all = [...PERMISSIONS];

/** What each role can do by default. A user's own `permissions` list adds to this. */
export const ROLE_PERMISSIONS = {
  SUPER_ADMIN: [],
  ORG_ADMIN: all,
  BRANCH_MANAGER: ['inventory:read', 'inventory:write', 'transfer:manage', 'transfer:approve', 'transfer:dispatch', 'transfer:receive', 'billing:read', 'billing:create', 'orders:approve', 'returns:approve', 'returns:refund', 'reports:read', 'audit:read', 'settings:read'],
  INVENTORY_MANAGER: ['inventory:read', 'inventory:write', 'inventory:delete', 'transfer:manage', 'transfer:dispatch', 'transfer:receive', 'reports:read', 'settings:read'],
  BILLING_STAFF: ['inventory:read', 'billing:read', 'billing:create', 'returns:refund', 'settings:read'],
  STAFF: ['inventory:read', 'settings:read'],
};

/** Permissions that come with another one, so older role setups keep working: transfer:manage covers the everyday steps,
 *  transfer:approve covers rejecting, and anyone who can read inventory can view and print transfers. */
const IMPLIES = {
  'transfer:manage': ['transfer:create', 'transfer:edit', 'transfer:submit', 'transfer:cancel'],
  'transfer:approve': ['transfer:reject'],
  'inventory:read': ['transfer:view', 'transfer:print'],
};

/**
 * Effective permissions = what the role grants + any extras granted to the individual user (+ what those imply).
 *
 * WHERE THE ROLE'S GRANT COMES FROM. Roles used to exist only here, as the ROLE_PERMISSIONS map. They are now rows in
 * the `roles` collection that an organization can edit, so the authoritative list for a given request is whatever that
 * row says RIGHT NOW. `authenticate` reads it on every request (as it already re-reads the user) and hangs it on
 * `user.rolePermissions`; this function prefers it when it is there.
 *
 * The map below remains the fallback, and it is not dead code: it is what a database that has never run the roles
 * migration still runs on, what seeds the system rows in the first place, and what the tests measure those rows
 * against. A role whose row is missing therefore behaves exactly as it did before the roles module existed, rather
 * than silently losing every permission.
 */
export const effectivePermissions = (user) => {
  const fromRole = user.rolePermissions || ROLE_PERMISSIONS[user.role] || [];
  const granted = [...fromRole, ...(user.permissions || [])];
  return [...new Set([...granted, ...granted.flatMap((g) => IMPLIES[g] || [])])];
};

export const hasPermission = (user, permission) => effectivePermissions(user).includes(permission);

/**
 * The catalogue the Roles screen renders. The client never hard-codes a permission string: it asks the server for
 * this, so a permission added here appears in the dialog without a second edit in the client, and a permission that is
 * NOT here cannot be granted (saving an unknown one is refused outright rather than quietly dropped).
 *
 * The order is the order the dialog shows. Within a group the view-only permission comes last, so the dangerous ones
 * are not the ones nearest the mouse.
 */
export const PERMISSION_GROUPS = [
  {
    key: 'inventory',
    label: 'Inventory',
    permissions: [
      ['inventory:write', 'Add and edit stock', 'Create medicines and batches, and correct what is on the shelf'],
      ['inventory:delete', 'Delete stock records', 'Remove medicines and batches entirely'],
      ['inventory:read', 'View inventory', 'See medicines, batches and stock levels'],
    ],
  },
  {
    key: 'billing',
    label: 'Billing',
    permissions: [
      ['billing:create', 'Create invoices', 'Sell at the Selling Point and raise an invoice'],
      ['billing:read', 'View invoices', 'See invoices and their line items'],
    ],
  },
  {
    key: 'transfers',
    label: 'Interstore transfers',
    permissions: [
      ['transfer:manage', 'Manage transfers', 'Umbrella: create, edit, submit and cancel. Covers the four below'],
      ['transfer:create', 'Create transfers', 'Draft a new transfer between stores'],
      ['transfer:edit', 'Edit draft transfers', 'Change or delete a transfer that has not been submitted'],
      ['transfer:submit', 'Submit transfers', 'Send a draft on for approval'],
      ['transfer:cancel', 'Cancel transfers', 'Cancel a transfer that has not been fully received'],
      ['transfer:approve', 'Approve transfers', 'Approve or reject a submitted transfer'],
      ['transfer:dispatch', 'Dispatch transfers', 'Confirm that approved stock has left the source store'],
      ['transfer:receive', 'Receive transfers', 'Record what actually arrived at the destination store'],
      ['transfer:view', 'View transfers', 'See transfers (anyone who can view inventory already can)'],
      ['transfer:print', 'Print transfers', 'Print or download the transfer document'],
      ['transfer:reject', 'Reject transfers', 'Reject a submitted transfer (anyone who can approve already can)'],
    ],
  },
  {
    key: 'orders',
    label: 'Purchase orders',
    permissions: [['orders:approve', 'Approve orders', 'Approve or send back a supplier order, where approval is required']],
  },
  {
    key: 'returns',
    label: 'Sales returns',
    permissions: [
      ['returns:approve', 'Approve returns', 'Approve or reject a customer return, and decide what is restocked'],
      ['returns:refund', 'Process refunds', 'Record a refund moving through processing, completed or failed'],
    ],
  },
  {
    key: 'reports',
    label: 'Reports and analytics',
    permissions: [
      ['reports:read', 'View reports', 'Every analytics page: sales, profit, GST, expiry, low stock'],
      ['audit:read', 'View the activity log', 'See who changed what, and when'],
    ],
  },
  {
    key: 'admin',
    label: 'Administration',
    permissions: [
      ['users:manage', 'Manage users and roles', 'Create users, assign roles, and edit what a role may do'],
      ['settings:manage', 'Change settings', 'Edit the organization profile, invoice layout and common settings'],
      ['settings:read', 'View settings', 'See the settings screens without being able to change them'],
    ],
  },
];

/** Every permission in the catalogue, in display order. A test holds this to PERMISSIONS exactly, both ways. */
export const CATALOGUE_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map(([p]) => p));

export const PERMISSION_LABEL = Object.fromEntries(PERMISSION_GROUPS.flatMap((g) => g.permissions.map(([p, label]) => [p, label])));

/**
 * The roles every organization starts with. They are seeded as rows (isSystem: true) so the screen is not half code
 * and half data: an organization can change what they may do, but cannot rename or delete them, because `User.role`
 * holds the key and existing users point at it.
 *
 * SUPER_ADMIN is deliberately absent. It is a platform-level role that belongs to no organization and cannot use
 * tenant routes at all (see the top of this file), so a per-organization row for it would be a lie on the screen.
 */
export const SYSTEM_ROLES = [
  { key: 'ORG_ADMIN', name: 'Organization Admin', description: 'Full access to everything in this organization, including users, roles and settings.' },
  { key: 'BRANCH_MANAGER', name: 'Branch Manager', description: 'Runs a store: stock, billing, transfers, approvals and reports.' },
  { key: 'INVENTORY_MANAGER', name: 'Inventory Manager', description: 'Looks after stock and transfers, without billing.' },
  { key: 'BILLING_STAFF', name: 'Billing Staff', description: 'Works the Selling Point: sells, refunds and looks stock up.' },
  { key: 'STAFF', name: 'Staff', description: 'Can look things up, and change nothing.' },
];

export const SYSTEM_ROLE_KEYS = SYSTEM_ROLES.map((r) => r.key);

/** A custom role's key is generated from its name and must look like this; it is what `User.role` stores. */
export const ROLE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
