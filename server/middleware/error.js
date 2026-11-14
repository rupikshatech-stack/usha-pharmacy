import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

export const notFound = (req, _res, next) => next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, _req, res, _next) => {
  let status = err.status || 500;
  let message = err.message || 'Server error';

  if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  } else if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large';
  } else if (err.name === 'CastError' || err.name === 'BSONError' || err.name === 'BSONTypeError') {
    status = 400;
    message = 'Invalid identifier';
  } else if (err.code === 11000) {
    status = 409;
    message = 'A record with these details already exists';
  } else if (err.name === 'ValidationError') {
    status = 400;
  }

  if (status >= 500) {
    console.error('[error]', err);
    if (env.isProd) message = 'Something went wrong';
  }

  res.status(status).json({ success: false, message, code: err.code, details: err.details });
};
