import { Router } from 'express';
import { tenantGuard } from '../middleware/guards.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { alertsQuery, monthlySalesQuery, overviewQuery, recentActivityQuery, stockLevelsQuery } from '../validators/dashboard.validator.js';
import * as ctrl from '../controllers/dashboard.controller.js';

const router = Router();
router.use(...tenantGuard); // any member of the organization may view the dashboard; data is always their own organization's

router.get('/overview', validate(overviewQuery, 'query'), h(ctrl.overview));
router.get('/monthly-sales', validate(monthlySalesQuery, 'query'), h(ctrl.monthlySales));
router.get('/stock-levels', validate(stockLevelsQuery, 'query'), h(ctrl.stockLevels));
router.get('/recent-activity', validate(recentActivityQuery, 'query'), h(ctrl.recentActivity));
router.get('/alerts', validate(alertsQuery, 'query'), h(ctrl.alerts));

export default router;
