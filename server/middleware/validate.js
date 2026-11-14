import { ApiError } from '../utils/ApiError.js';

/** Validates req[source] with a zod schema. Unknown keys (e.g. a spoofed organizationId) are stripped. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const parsed = schema.safeParse(req[source]);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return next(new ApiError(400, details[0]?.message || 'Invalid request', details));
  }
  // Express 5 makes req.query a getter, so redefine the property instead of assigning.
  Object.defineProperty(req, source, { value: parsed.data, writable: true, configurable: true, enumerable: true });
  next();
};
