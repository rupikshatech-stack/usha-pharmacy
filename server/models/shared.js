import mongoose from 'mongoose';

export const { Schema, Types } = mongoose;

/**
 * Every organization-owned collection carries a required organizationId. It is deliberately NOT
 * indexed on its own: each collection defines compound indexes that START with organizationId,
 * which also serve plain per-tenant lookups.
 */
export const orgField = { type: Types.ObjectId, ref: 'Organization', required: true };

export const timestamps = { timestamps: true };
