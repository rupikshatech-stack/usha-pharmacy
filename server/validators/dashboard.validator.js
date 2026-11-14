import { z } from 'zod';

// Calendar dates are interpreted in the organization's timezone ("2026-04-01" = that local day).
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');

export const overviewQuery = z.object({ from: dateStr.optional(), to: dateStr.optional() });

export const monthlySalesQuery = z.object({
  months: z.coerce.number().int().min(1, 'months must be 1–24').max(24, 'months must be 1–24').optional().default(6),
});

export const stockLevelsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

export const recentActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  from: dateStr.optional(),
  to: dateStr.optional(),
});

export const alertsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
  // No default here: the window comes from the organization's own expiry thresholds (90 days unless it changed them).
  expiryDays: z.coerce.number().int().min(1).max(365).optional(),
});
