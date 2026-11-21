import type { Prisma } from '@prisma/client';
import { prisma, TX_OPTS, type Tx } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { EventEnvelope, MessageBus } from '../bus/types.js';

export interface OutboxInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** Optional idempotency key. Duplicate keys are silently ignored (ON CONFLICT DO NOTHING). */
  dedupeKey?: string;
}

/** Transactional outbox: write the event in the SAME transaction as the business state change. */
export async function enqueueEvent(tx: Tx, e: OutboxInput): Promise<boolean> {
  const r = await tx.outboxEvent.createMany({
    data: [
      {
        eventType: e.type,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        payload: e.payload as Prisma.InputJsonValue,
        dedupeKey: e.dedupeKey ?? null,
      },
    ],
    skipDuplicates: true,
  });
  return r.count === 1;
}

export async function enqueueEvents(tx: Tx, events: OutboxInput[]): Promise<number> {
  if (!events.length) return 0;
  const r = await tx.outboxEvent.createMany({
    data: events.map((e) => ({
      eventType: e.type,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      payload: e.payload as Prisma.InputJsonValue,
      dedupeKey: e.dedupeKey ?? null,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

interface OutboxRow {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

const MAX_PUBLISH_ATTEMPTS = 12;

/**
 * Publish a batch of pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED so
 * several publisher instances can run safely. Rows are marked PUBLISHED only after the broker confirms.
 */
export async function publishPendingOutbox(bus: MessageBus, limit = 100): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, "eventType", "aggregateType", "aggregateId", payload, attempts, "createdAt"
      FROM "OutboxEvent"
      WHERE status = 'PENDING' AND "availableAt" <= now()
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return 0;
    const published: string[] = [];
    for (const row of rows) {
      const evt: EventEnvelope = {
        id: row.id,
        type: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: row.payload,
        occurredAt: new Date(row.createdAt).toISOString(),
      };
      try {
        await bus.publish(evt);
        published.push(row.id);
      } catch (err) {
        const attempts = row.attempts + 1;
        const delayMs = Math.min(5 * 60_000, 1000 * 2 ** attempts);
        await tx.outboxEvent.update({
          where: { id: row.id },
          data: {
            attempts,
            lastError: (err as Error).message.slice(0, 500),
            availableAt: new Date(Date.now() + delayMs),
            status: attempts >= MAX_PUBLISH_ATTEMPTS ? 'FAILED' : 'PENDING',
          },
        });
        logger.warn('outbox publish failed', { id: row.id, type: row.eventType, attempts, err });
        // Broker is likely down: stop this round, the remaining rows stay PENDING.
        break;
      }
    }
    if (published.length) {
      await tx.outboxEvent.updateMany({
        where: { id: { in: published } },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    }
    return published.length;
  }, TX_OPTS);
}

/** Consumer-side idempotency: returns false if this consumer already processed the event. */
export async function markProcessed(consumer: string, eventId: string, tx: Tx = prisma): Promise<boolean> {
  const r = await tx.processedEvent.createMany({ data: [{ consumer, eventId }], skipDuplicates: true });
  return r.count === 1;
}
