import {
  LayoutDashboard,
  ScanBarcode,
  FileText,
  Boxes,
  Pill,
  ChartNoAxesCombined,
  CalendarClock,
  Gauge,
  FlaskConical,
  Layers,
  ArrowLeftRight,
  Upload,
  Tag,
  Undo2,
  ClipboardList,
  Building2,
  Wallet,
  Truck,
  History,
  PiggyBank,
  Receipt,
  Package,
  Warehouse,
  ReceiptIndianRupee,
  Users,
  PackageX,
  Settings2,
  ShieldCheck,
} from 'lucide-react';

/**
 * Sidebar structure. An item with `children` is an expandable group (no route of its own).
 * `permission` is the permission the page needs; the server enforces it, the client only uses it to
 * hide links the user couldn't open. "Log Out" is rendered separately at the bottom of the sidebar.
 */
export const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/selling-point', label: 'Selling Point', icon: ScanBarcode, permission: 'billing:create' },
  { to: '/invoices', label: 'Recent Invoices', icon: FileText, permission: 'billing:read' },
  {
    label: 'Stock Management',
    icon: Boxes,
    children: [
      { to: '/inventory', label: 'All Inventory', icon: Pill, permission: 'inventory:read' },
      { to: '/inventory/compounds', label: 'All Compound', icon: FlaskConical, permission: 'inventory:read' },
      { to: '/inventory/batches', label: 'Inventory Batch', icon: Layers, permission: 'inventory:read' },
      { to: '/inventory/transfers', label: 'Inter Store Transfer', icon: ArrowLeftRight, permission: 'inventory:read' },
      { to: '/inventory/import', label: 'Import Inventory', icon: Upload, permission: 'inventory:write' },
      { to: '/inventory/attributes', label: 'Attributes', icon: Tag, permission: 'inventory:read' },
    ],
  },
  { to: '/sales-returns', label: 'Sales Returns', icon: Undo2, permission: 'billing:read' },
  { to: '/orders', label: 'Orders', icon: ClipboardList, permission: 'inventory:read' },
  { to: '/branches', label: 'Branch', icon: Building2, permission: 'inventory:read' },
  { to: '/credit', label: 'Credit Management', icon: Wallet },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, permission: 'inventory:read' },
  {
    label: 'Business Analytics',
    icon: ChartNoAxesCombined,
    children: [
      { to: '/analytics', label: 'Overview', icon: Gauge, permission: 'reports:read' },
      { to: '/analytics/sales', label: 'Sales Report', icon: Receipt, permission: 'reports:read' },
      { to: '/analytics/purchases', label: 'Purchase Report', icon: Package, permission: 'reports:read' },
      { to: '/analytics/profitability', label: 'Profitability', icon: PiggyBank, permission: 'reports:read' },
      { to: '/analytics/inventory', label: 'Inventory Analytics', icon: Warehouse, permission: 'reports:read' },
      { to: '/analytics/low-stock', label: 'Low Stock', icon: PackageX, permission: 'reports:read' },
      { to: '/analytics/expiry', label: 'Expiry Intelligence', icon: CalendarClock, permission: 'reports:read' },
      { to: '/analytics/gst', label: 'GST Report', icon: ReceiptIndianRupee, permission: 'reports:read' },
      { to: '/analytics/customers', label: 'Customer Insights', icon: Users, permission: 'reports:read' },
      { to: '/analytics/suppliers', label: 'Supplier Performance', icon: Truck, permission: 'reports:read' },
      { to: '/analytics/branches', label: 'Branch Performance', icon: Building2, permission: 'reports:read' },
    ],
  },
  { to: '/activity', label: 'Activity Log', icon: History, permission: 'audit:read' },
  { to: '/roles', label: 'Roles & Users', icon: ShieldCheck, permission: 'users:manage' },
  { to: '/settings', label: 'Settings', icon: Settings2, permission: 'settings:read' },
];

/** Modules that exist in the navigation but aren't built yet: they show a "Coming soon" page. */
export const placeholderRoutes = [];

/** Coming-soon pages that are linked from the dashboard but are not in the sidebar. */
export const hiddenPlaceholders = [{ path: '/reports', title: 'Reports' }];

export const userCan = (user, permission) => !permission || Boolean(user?.permissions?.includes(permission));

/** The navigation the signed-in user may use (groups with no accessible child disappear). */
export function visibleNav(user) {
  return navItems
    .map((item) => (item.children ? { ...item, children: item.children.filter((c) => userCan(user, c.permission)) } : item))
    .filter((item) => (item.children ? item.children.length > 0 : userCan(user, item.permission)));
}

/** Number of modules (pages) the user can open — what the dashboard banner reports. */
export const countModules = (user) => visibleNav(user).reduce((n, item) => n + (item.children ? item.children.length : 1), 0);

/** Pages inside a page of the menu: they are not menu items themselves, but the breadcrumb shows them under their parent. */
export const subPages = [
  { path: '/orders/ai-billing', label: 'AI Billing', parent: '/orders' },
  { path: '/analytics/transactions', label: 'Daily Transaction Report', parent: '/analytics' },
];

/** Finds the nav item for a path (and its parent group, if any) — used by breadcrumbs. */
export function findNav(pathname) {
  const match = (i) => pathname === i.to || pathname.startsWith(`${i.to}/`);
  // The most specific match wins: /inventory/batches is "Inventory Batch", not "All Inventory".
  let best = null;
  for (const item of navItems) {
    const candidates = item.children ? item.children.map((c) => ({ parent: item, item: c })) : [{ parent: null, item }];
    for (const c of candidates) {
      if (match(c.item) && (!best || c.item.to.length > best.item.to.length)) best = c;
    }
  }
  return best;
}

/** A page title for any known path, including dashboard-only placeholders. */
export const pageTitle = (pathname) => findNav(pathname)?.item.label || hiddenPlaceholders.find((p) => p.path === pathname)?.title;
