import { Router } from 'express';
import { health } from '../controllers/health.controller.js';
import { csrfProtect } from '../middleware/csrf.js';
import auth from './auth.routes.js';
import medicines from './medicine.routes.js';
import invoices from './invoice.routes.js';
import salesReturns from './salesReturn.routes.js';
import orders from './order.routes.js';
import suppliers from './supplier.routes.js';
import aiBilling from './aiBilling.routes.js';
import { goodsReceipts, purchases } from './goodsReceipt.routes.js';
import analytics from './analytics.routes.js';
import credits from './credit.routes.js';
import pos from './pos.routes.js';
import dashboard from './dashboard.routes.js';
import activity from './activity.routes.js';
import organization from './organization.routes.js';
import settings from './settings.routes.js';
import { roles, users } from './roles.routes.js';
import platform from './platform.routes.js';
import stock from './stock.routes.js';
import batches from './batch.routes.js';
import imports from './import.routes.js';
import { stores, transfers } from './transfer.routes.js';
import { attributes, compounds } from './catalog.routes.js';

const api = Router();

api.get('/health', health);
api.use(csrfProtect); // every state-changing request that uses our cookies needs the CSRF header
api.use('/auth', auth);
api.use('/inventory', medicines); // the inventory API (GET/POST /, GET/PUT/DELETE /:id, batches, restore)
api.use('/medicines', medicines); // older name for the same routes, kept so existing clients keep working
api.use('/invoices', invoices);
api.use('/sales-returns', salesReturns);
api.use('/orders', orders);
api.use('/suppliers', suppliers);
api.use('/ai-billing', aiBilling);
api.use('/goods-receipts', goodsReceipts); // goods receipts: draft -> confirm (adds stock) -> reverse
api.use('/credits', credits); // credit requests: pay, upload the payment screenshot, view the history
api.use('/purchases', purchases); // purchase history of an order
api.use('/pos', pos);
api.use('/analytics', analytics); // business analytics: aggregated in the database, never in the browser
api.use('/dashboard', dashboard);
api.use('/activity', activity);
api.use('/organization', organization); // the older, narrower profile endpoint; /settings is the full surface
api.use('/settings', settings);
api.use('/roles', roles); // the administration screens
api.use('/users', users);
api.use('/platform', platform); // platform administration: no tenant, never under tenantGuard
api.use('/stock', stock);
api.use('/transfers', transfers); // inter-store transfers (draft -> send -> receive)
api.use('/branches', stores); // the organization's stores
api.use('/import', imports); // CSV inventory import: template, preview, confirm, history
api.use('/batches', batches); // every batch across medicines: list, expiry alerts, add, edit, movement history
api.use('/compounds', compounds);
api.use('/attributes', attributes);

export default api;
