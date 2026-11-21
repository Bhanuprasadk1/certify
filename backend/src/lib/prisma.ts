import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { env } from '../config/env.js';

export const pgPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
});

const adapter = new PrismaPg(pgPool);

export const prisma = new PrismaClient({
  adapter,
  log: [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
});

export type Tx = Prisma.TransactionClient;

/** Interactive transaction defaults tuned for remote PostgreSQL connections. */
export const TX_OPTS = { maxWait: 15_000, timeout: 60_000 } as const;

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Row-level lock used to serialise concurrent workflow decisions on a batch. */
export async function lockBatch(tx: Tx, batchId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;
  return rows.length === 1;
}

export async function lockCertificate(tx: Tx, certificateId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Certificate" WHERE id = ${certificateId} FOR UPDATE`;
  return rows.length === 1;
}
