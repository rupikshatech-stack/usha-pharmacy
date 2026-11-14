import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { corsOptions } from './config/cors.js';
import { errorHandler, notFound } from './middleware/error.js';
import api from './routes/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  if (!env.isProd && !env.isTest) app.use(morgan('dev'));

  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
