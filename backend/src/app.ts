import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { corsOrigins, env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimit.middleware.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { authRouter } from './routes/auth.routes.js';
import { batchesRouter } from './routes/batches.routes.js';
import { certificatesRouter } from './routes/certificates.routes.js';
import { operationsRouter } from './routes/operations.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || corsOrigins.includes(origin)) return cb(null, true);
        cb(new Error('CORS origin not allowed'));
      },
      credentials: true,
    }),
  );

  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api', batchesRouter);
  app.use('/api', certificatesRouter);
  app.use('/api', operationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
