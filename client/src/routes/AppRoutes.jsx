import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthOnlyRoute, GuestRoute, ProtectedRoute } from './ProtectedRoute';
import { hiddenPlaceholders, pageTitle, placeholderRoutes } from '../components/layout/nav';
import Login from '../pages/auth/Login';
import ForgotPassword from '../pages/auth/ForgotPassword';
import ChangePassword from '../pages/auth/ChangePassword';
import Dashboard from '../pages/dashboard/Dashboard';
import Inventory from '../pages/inventory/Inventory';
import Batches from '../pages/inventory/Batches';
import Import from '../pages/inventory/Import';
import Transfers from '../pages/inventory/Transfers';
import Compounds from '../pages/inventory/Compounds';
import Attributes from '../pages/inventory/Attributes';
import SellingPoint from '../pages/sales/SellingPoint';
import Invoices from '../pages/sales/Invoices';
import SalesReturns from '../pages/sales/SalesReturns';
import Orders from '../pages/orders/Orders';
import AiBilling from '../pages/orders/AiBilling';
import Activity from '../pages/system/Activity';
import ComingSoon from '../pages/ComingSoon';
import Branches from '../pages/branches/Branches';
import CreditManagement from '../pages/credit/CreditManagement';
import Suppliers from '../pages/suppliers/Suppliers';
import Analytics from '../pages/analytics/Analytics';
import Transactions from '../pages/analytics/Transactions';
import SalesReport from '../pages/analytics/SalesReport';
import PurchaseReport from '../pages/analytics/PurchaseReport';
import Profitability from '../pages/analytics/Profitability';
import InventoryAnalytics from '../pages/analytics/InventoryAnalytics';
import GstReport from '../pages/analytics/GstReport';
import CustomerInsights from '../pages/analytics/CustomerInsights';
import SupplierPerformance from '../pages/analytics/SupplierPerformance';
import BranchPerformance from '../pages/analytics/BranchPerformance';
import LowStock from '../pages/analytics/LowStock';
import Settings from '../pages/settings/Settings';
import RolesAndUsers from '../pages/roles/RolesAndUsers';
import PlatformApp from '../pages/platform/PlatformApp';
import ExpiryIntelligence from '../pages/analytics/ExpiryIntelligence';

const RedirectKeepingQuery = ({ to }) => <Navigate to={to + useLocation().search} replace />;

const guest = (el) => <GuestRoute>{el}</GuestRoute>;

export default function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={guest(<Login />)} />
      <Route path="/forgot-password" element={guest(<ForgotPassword />)} />

      {/*
        The platform area. Outside ProtectedRoute on purpose: a platform administrator has no organization, so the
        tenant guard, the app shell and AuthContext all have nothing to say about them. It owns its own sign-in,
        its own session check and its own frame, and it is reachable only by typing the address — nothing in the
        pharmacy app links here.
      */}
      <Route path="/platform" element={<PlatformApp />} />

      {/* Signed in, no app shell */}
      <Route element={<AuthOnlyRoute />}>
        <Route path="/change-password" element={<ChangePassword />} />
      </Route>

      {/* Signed in: the application */}
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/selling-point" element={<SellingPoint />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/sales-returns" element={<SalesReturns />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/ai-billing" element={<AiBilling />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/branches" element={<Branches />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/analytics/transactions" element={<Transactions />} />
        <Route path="/analytics/sales" element={<SalesReport />} />
        <Route path="/analytics/purchases" element={<PurchaseReport />} />
        <Route path="/analytics/profitability" element={<Profitability />} />
        <Route path="/analytics/inventory" element={<InventoryAnalytics />} />
        <Route path="/analytics/gst" element={<GstReport />} />
        <Route path="/analytics/customers" element={<CustomerInsights />} />
        <Route path="/analytics/suppliers" element={<SupplierPerformance />} />
        <Route path="/analytics/branches" element={<BranchPerformance />} />
        <Route path="/analytics/low-stock" element={<LowStock />} />
        <Route path="/analytics/expiry" element={<ExpiryIntelligence />} />
        {/* The name the old product used for this screen, kept so an existing bookmark or link still lands. */}
        <Route path="/analytics/expiry-reports" element={<RedirectKeepingQuery to="/analytics/expiry" />} />
        <Route path="/reports/expiry" element={<RedirectKeepingQuery to="/analytics/expiry" />} />
        <Route path="/credit" element={<CreditManagement />} />
        <Route path="/inventory/batches" element={<Batches />} />
        <Route path="/stock/inventory" element={<RedirectKeepingQuery to="/inventory" />} />
        <Route path="/stock/batches" element={<RedirectKeepingQuery to="/inventory/batches" />} />
        <Route path="/inventory/import" element={<Import />} />
        <Route path="/stock/import" element={<RedirectKeepingQuery to="/inventory/import" />} />
        <Route path="/inventory/transfers" element={<Transfers />} />
        <Route path="/stock/transfers" element={<RedirectKeepingQuery to="/inventory/transfers" />} />
        <Route path="/inventory/compounds" element={<Compounds />} />
        <Route path="/inventory/attributes" element={<Attributes />} />
        <Route path="/stock/compounds" element={<RedirectKeepingQuery to="/inventory/compounds" />} />
        <Route path="/stock/attributes" element={<RedirectKeepingQuery to="/inventory/attributes" />} />
        <Route path="/activity" element={<Activity />} />
        {/* The tab lives in the URL, so a tab can be linked, bookmarked and opened in a second window. */}
        <Route path="/roles" element={<Navigate to="/roles/roles" replace />} />
        <Route path="/roles/:tab" element={<RolesAndUsers />} />
        <Route path="/settings" element={<Navigate to="/settings/organization" replace />} />
        <Route path="/settings/:tab" element={<Settings />} />
        {[...placeholderRoutes, ...hiddenPlaceholders.map((p) => p.path)].map((p) => (
          <Route key={p} path={p} element={<ComingSoon title={pageTitle(p)} />} />
        ))}
      </Route>

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
