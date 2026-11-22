import { LayoutDashboard, Boxes, CalendarClock, ReceiptText, BarChart3, Truck, WalletCards, Building2 } from 'lucide-react';
import DashboardView from './DashboardView';
import InventoryView from './InventoryView';
import BatchView from './BatchView';
import POSView from './POSView';
import AnalyticsView from './AnalyticsView';
import OrdersView from './OrdersView';
import CreditView from './CreditView';
import BranchView from './BranchView';

/**
 * The single source of truth for the showcase. To add a slide, add ONE entry here: the scroll timeline, the
 * progress indicator, the sidebar, the stacked mobile cards and the scroll length all follow the array length.
 *
 *   id          unique key
 *   short       label in the progress indicator
 *   nav         label in the ERP sidebar
 *   icon        sidebar icon
 *   title, description, highlights   the copy beside the window
 *   view        the React component rendered inside the window
 */
export const SLIDES = [
  {
    id: 'dashboard',
    short: 'Dashboard',
    nav: 'Dashboard',
    icon: LayoutDashboard,
    title: 'A live view of your whole pharmacy',
    description:
      "Revenue, invoices and stock alerts on one calm screen, so the day's priorities are clear before the first customer walks in.",
    highlights: ["Today's and total revenue side by side", 'Low-stock alerts surfaced automatically', 'Recent activity across billing and stock'],
    view: DashboardView,
  },
  {
    id: 'inventory',
    short: 'Inventory',
    nav: 'Inventory',
    icon: Boxes,
    title: 'Every medicine, always accounted for',
    description: 'Search, filter and manage the full medicine catalogue, with stock levels and reorder points visible at a glance.',
    highlights: ['Search and filter by category', 'Reorder levels with clear status badges', 'Manufacturer and stock in one table'],
    view: InventoryView,
  },
  {
    id: 'batches',
    short: 'Batches',
    nav: 'Batches',
    icon: CalendarClock,
    title: 'Catch expiry before it costs you',
    description: 'Track every batch with its manufacture and expiry dates, so near-expiry stock is found while it can still be sold.',
    highlights: ['Orange and red expiry warnings', 'Batch-wise quantity and MRP', 'Earliest-expiry batches sold first'],
    view: BatchView,
  },
  {
    id: 'pos',
    short: 'POS',
    nav: 'Selling Point',
    icon: ReceiptText,
    title: 'Fast, accurate billing at the counter',
    description: 'Search a medicine, pick the batch, apply a discount and raise the invoice, all from one keyboard-friendly screen.',
    highlights: ['Choose the batch for every line', 'Item discounts and payment modes', 'Customer details and one-click invoice'],
    view: POSView,
  },
  {
    id: 'analytics',
    short: 'Analytics',
    nav: 'Analytics',
    icon: BarChart3,
    title: 'Decisions backed by your own numbers',
    description: 'Turn daily sales and stock movement into trends you can act on, from revenue to category performance.',
    highlights: ['Revenue trend and monthly sales', 'Inventory distribution by category', 'Sales performance and stock alerts'],
    view: AnalyticsView,
  },
  {
    id: 'suppliers',
    short: 'Suppliers',
    nav: 'Suppliers',
    icon: Truck,
    title: 'Stay on top of suppliers and orders',
    description: 'Raise purchase orders, track what is on its way, and see which suppliers deliver on time.',
    highlights: ['Purchase orders and receiving in one place', 'Supplier directory with contact details', 'Supplier performance reports'],
    view: OrdersView,
  },
  {
    id: 'credit',
    short: 'Credit',
    nav: 'Credit',
    icon: WalletCards,
    title: 'Credit you can actually collect',
    description: 'Keep a clear ledger of what customers owe, with requests, history and proof of payment.',
    highlights: ['Credit requests and approvals', 'Running ledger per customer', 'Payment proof attached to each entry'],
    view: CreditView,
  },
  {
    id: 'branches',
    short: 'Branches',
    nav: 'Branches',
    icon: Building2,
    title: 'Every branch, the right access',
    description:
      'Run several stores from one system, move stock between them, and give each person only the access their role needs.',
    highlights: ['Inter-store stock transfers', 'Branch-wise performance', 'Role-based permissions per user'],
    view: BranchView,
  },
];
