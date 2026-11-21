import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let client: Redis | null = null;

/** Redis is optional: used for distributed rate limiting when configured. PostgreSQL stays the source of truth. */
export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
    client.on('error', (err) => logger.warn('redis error', { err: err.message }));
  }
  return client;
}

export async function redisPing(): Promise<'up' | 'down' | 'not_configured'> {
  const r = getRedis();
  if (!r) return 'not_configured';
  try {
    const res = await Promise.race([r.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
    return res === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export async function closeRedis() {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
