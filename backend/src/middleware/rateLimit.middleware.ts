import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env, isTest } from '../config/env.js';
import { getRedis } from '../lib/redis.js';

function makeLimiter(prefix: string, windowMs: number, limit: number, message: string) {
  const redis = isTest ? null : getRedis();
  const opts: Partial<Options> = {
    windowMs,
    limit: isTest ? 10_000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message },
  };
  if (redis) {
    opts.store = new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args: string[]) => redis.call(args[0], ...args.slice(1)) as Promise<never>,
    });
  }
  return rateLimit(opts);
}

export const loginLimiter = makeLimiter('login', 15 * 60_000, env.LOGIN_RATE_LIMIT, 'Too many login attempts. Please try again later.');
export const apiLimiter = makeLimiter('api', 60_000, env.API_RATE_LIMIT, 'Too many API requests. Please slow down.');
export const verifyLimiter = makeLimiter('verify', 60_000, env.VERIFY_RATE_LIMIT, 'Too many verification requests. Please retry shortly.');
