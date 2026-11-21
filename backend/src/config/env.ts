import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  PUBLIC_APP_URL: z.string().default('http://localhost:5173'),
  REDIS_URL: z.string().optional().transform((v) => (v ? v : undefined)),
  RABBITMQ_URL: z.string().optional().transform((v) => (v ? v : undefined)),
  QUEUE_DRIVER: z.enum(['rabbitmq', 'memory']).default('memory'),
  STORAGE_DIR: z.string().default('./storage'),
  DEMO_MODE: bool(true),
  DEMO_PASSWORD: z.string().min(8).default('Demo@1234'),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  API_RATE_LIMIT: z.coerce.number().int().positive().default(600),
  VERIFY_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Never print values (they may contain secrets) — only the failing keys.
  const keys = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new Error(`Invalid environment configuration -> ${keys}`);
}

export const env = parsed.data;
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
