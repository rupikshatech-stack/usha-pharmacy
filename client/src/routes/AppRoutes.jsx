import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthOnlyRoute, GuestRoute, ProtectedRoute } from './ProtectedRoute';
import { hiddenPlaceholders, pageTitle, placeholderRoutes } from '../components/layout/nav';
import Landing from '../pages/landing/Landing';
import { Spinner } from '../components/common/ui';

// Every screen but the landing page is its own chunk, so a visitor to / does not download the application.
const Login = lazy(() => import('../pages/auth/Login'));
const ForgotPassword = lazy(() => import('../pages/auth/ForgotPassword'));
const ChangePassword = lazy(() => import('../pages/auth/ChangePassword'));
const Dashboard = lazy(() => import('../pages/dashboard/Dashboard'));
const Inventory = lazy(() => import('../pages/inventory/Inventory'));
const Batches = lazy(() => import('../pages/inventory/Batches'));
const Import = lazy(() => import('../pages/inventory/Import'));
const Transfers = lazy(() => import('../pages/inventory/Transfers'));
const Compounds = lazy(() => import('../pages/inventory/Compounds'));
const Attributes = lazy(() => import('../pages/inventory/Attributes'));
const SellingPoint = lazy(() => import('../pages/sales/SellingPoint'));
const Invoices = lazy(() => import('../pages/sales/Invoices'));
const SalesReturns = lazy(() => import('../pages/sales/SalesReturns'));
const Orders = lazy(() => import('../pages/orders/Orders'));
const AiBilling = lazy(() => import('../pages/orders/AiBilling'));
const Activity = lazy(() => import('../pages/system/Activity'));
const ComingSoon = lazy(() => import('../pages/ComingSoon'));
const Branches = lazy(() => import('../pages/branches/Branches'));
const CreditManagement = lazy(() => import('../pages/credit/CreditManagement'));
const Suppliers = lazy(() => import('../pages/suppliers/Suppliers'));
const Analytics = lazy(() => import('../pages/analytics/Analytics'));
const Transactions = lazy(() => import('../pages/analytics/Transactions'));
const SalesReport = lazy(() => import('../pages/analytics/SalesReport'));
const PurchaseReport = lazy(() => import('../pages/analytics/PurchaseReport'));
const Profitability = lazy(() => import('../pages/analytics/Profitability'));
const InventoryAnalytics = lazy(() => import('../pages/analytics/InventoryAnalytics'));
const GstReport = lazy(() => import('../pages/analytics/GstReport'));
const CustomerInsights = lazy(() => import('../pages/analytics/CustomerInsights'));
const SupplierPerformance = lazy(() => import('../pages/analytics/SupplierPerformance'));
const BranchPerformance = lazy(() => import('../pages/analytics/BranchPerformance'));
const LowStock = lazy(() => import('../pages/analytics/LowStock'));
const Settings = lazy(() => import('../pages/settings/Settings'));
const RolesAndUsers = lazy(() => import('../pages/roles/RolesAndUsers'));
const PlatformApp = lazy(() => import('../pages/platform/PlatformApp'));
const ExpiryIntelligence = lazy(() => import('../pages/analytics/ExpiryIntelligence'));

const RedirectKeepingQuery = ({ to }) => <Navigate to={to + useLocation().search} replace />;

const guest = (el) => <GuestRoute>{el}</GuestRoute>;

export default function AppRoutes() {
  return (
    <Suspense fallback={<Spinner />}>
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

        {/* The public landing page; a signed-in visitor is sent on to /dashboard by the page itself. */}
        <Route path="/" element={<Landing />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Suspense>
  );
}
