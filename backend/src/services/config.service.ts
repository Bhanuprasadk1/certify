import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { badRequest, zodToFieldErrors } from '../lib/errors.js';

export const configSchemas = {
  'quality.threshold': z.number().int().min(1).max(10_000),
  'district.requiredApprovals': z.number().int().min(1).max(5),
  'sla.minutes': z.object({
    DISTRICT_REVIEW: z.number().int().min(1).max(100_000),
    QUALITY_REVIEW: z.number().int().min(1).max(100_000),
    STATE_REVIEW: z.number().int().min(1).max(100_000),
  }),
  'delivery.mock': z.object({
    mode: z.enum(['deterministic', 'random', 'always_success', 'always_fail']),
    failureRate: z.number().min(0).max(1),
    timeoutRate: z.number().min(0).max(1),
    failDigits: z.array(z.string().regex(/^\d$/)).max(10),
    timeoutDigits: z.array(z.string().regex(/^\d$/)).max(10),
    latencyMs: z.number().int().min(0).max(5000),
  }),
  'delivery.retry': z.object({
    maxAttempts: z.number().int().min(1).max(10),
    baseSeconds: z.number().int().min(1).max(3600),
  }),
} as const;

export type ConfigKey = keyof typeof configSchemas;
export type ConfigValue<K extends ConfigKey> = z.infer<(typeof configSchemas)[K]>;

export const configDefaults: { [K in ConfigKey]: { value: ConfigValue<K>; description: string } } = {
  'quality.threshold': { value: 50, description: 'Batches with this many candidates or more require Quality review' },
  'district.requiredApprovals': { value: 2, description: 'Number of distinct District Officer approvals required' },
  'sla.minutes': {
    value: { DISTRICT_REVIEW: 30, QUALITY_REVIEW: 30, STATE_REVIEW: 30 },
    description: 'Demo SLA (minutes) per review stage before a batch is escalated',
  },
  'delivery.mock': {
    value: { mode: 'deterministic', failureRate: 0.2, timeoutRate: 0.1, failDigits: ['3'], timeoutDigits: ['7'], latencyMs: 120 },
    description:
      'Mock WhatsApp provider behaviour. deterministic: phones ending in failDigits always fail, timeoutDigits time out on first attempt',
  },
  'delivery.retry': { value: { maxAttempts: 4, baseSeconds: 10 }, description: 'Delivery retry policy (exponential backoff)' },
};

const cache = new Map<string, { value: unknown; at: number }>();
const TTL_MS = 2000;

export async function getConfig<K extends ConfigKey>(key: K): Promise<ConfigValue<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as ConfigValue<K>;
  const row = await prisma.systemConfiguration.findUnique({ where: { key } });
  let value: ConfigValue<K> = configDefaults[key].value;
  if (row) {
    const parsed = configSchemas[key].safeParse(row.value);
    if (parsed.success) value = parsed.data as ConfigValue<K>;
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}

export function clearConfigCache() {
  cache.clear();
}

export async function setConfig(key: string, value: unknown, updatedById: string | null) {
  if (!(key in configSchemas)) throw badRequest(`Unknown configuration key: ${key}`);
  const k = key as ConfigKey;
  const parsed = configSchemas[k].safeParse(value);
  if (!parsed.success) throw badRequest('Invalid configuration value', zodToFieldErrors(parsed.error));
  const row = await prisma.systemConfiguration.upsert({
    where: { key: k },
    update: { value: parsed.data as Prisma.InputJsonValue, updatedById },
    create: { key: k, value: parsed.data as Prisma.InputJsonValue, description: configDefaults[k].description, updatedById },
  });
  cache.delete(k);
  return row;
}

export async function listConfig() {
  const rows = await prisma.systemConfiguration.findMany();
  return (Object.keys(configDefaults) as ConfigKey[]).map((key) => {
    const row = rows.find((r) => r.key === key);
    return {
      key,
      value: row?.value ?? configDefaults[key].value,
      description: configDefaults[key].description,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export async function ensureConfigDefaults() {
  for (const key of Object.keys(configDefaults) as ConfigKey[]) {
    await prisma.systemConfiguration.upsert({
      where: { key },
      update: {},
      create: { key, value: configDefaults[key].value as Prisma.InputJsonValue, description: configDefaults[key].description },
    });
  }
}
