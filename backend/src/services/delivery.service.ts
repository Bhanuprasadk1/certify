import type { DeliveryOutcome } from '@prisma/client';
import { prisma, TX_OPTS } from '../lib/prisma.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { maskPhone, randomToken } from '../lib/crypto.js';
import { EVENTS } from '../bus/types.js';
import { audit } from './audit.service.js';
import { getConfig } from './config.service.js';
import { enqueueEvent } from './outbox.service.js';
import type { AuthUser } from './auth.service.js';
import { deliveryScope } from './scope.service.js';

interface MockResult {
  outcome: DeliveryOutcome;
  providerMessageId?: string;
  error?: string;
  durationMs: number;
}

/**
 * Realistic WhatsApp Mock Provider.
 * - Supports SUCCESS, TIMEOUT, FAILURE outcomes.
 * - Configurable failure/timeout rates or deterministic demo rules based on phone last digit.
 * - Deduplicates accepted messages by idempotencyKey so retries never send duplicate notifications
 *   once the mock provider has accepted a message.
 */
async function invokeMockWhatsApp(phone: string, idempotencyKey: string, attemptNo: number): Promise<MockResult> {
  const start = Date.now();
  const cfg = await getConfig('delivery.mock');
  if (cfg.latencyMs > 0) {
    await new Promise((r) => setTimeout(r, Math.min(cfg.latencyMs, 500)));
  }

  // Provider-side idempotency check
  const already = await prisma.mockWhatsAppMessage.findUnique({ where: { idempotencyKey } });
  if (already) {
    return { outcome: 'SUCCESS', providerMessageId: already.messageId, durationMs: Date.now() - start };
  }

  const lastDigit = phone.replace(/\D/g, '').slice(-1);
  let outcome: DeliveryOutcome = 'SUCCESS';
  let error: string | undefined;

  if (cfg.mode === 'always_success') {
    outcome = 'SUCCESS';
  } else if (cfg.mode === 'always_fail') {
    outcome = 'FAILURE';
    error = 'Simulated gateway failure (always_fail mode)';
  } else if (cfg.mode === 'deterministic') {
    if (cfg.failDigits.includes(lastDigit) && attemptNo <= 2) {
      // Fail first two attempts, succeed on attempt 3 so demo showcases retry -> recovery,
      // unless maxAttempts is exceeded. Keep digit '9' as permanent failure if configured in failDigits? No, let failDigits fail always until retried or mode changed, timeoutDigits fail only on attempt 1.
      outcome = 'FAILURE';
      error = `Mock gateway rejected delivery (502 upstream error for ...${lastDigit})`;
    } else if (cfg.timeoutDigits.includes(lastDigit) && attemptNo === 1) {
      outcome = 'TIMEOUT';
      error = `Mock WhatsApp API request timed out after 5000ms (transient)`;
    } else {
      outcome = 'SUCCESS';
    }
  } else {
    // random mode
    const roll = Math.random();
    if (roll < cfg.timeoutRate) {
      outcome = 'TIMEOUT';
      error = 'Simulated WhatsApp API timeout';
    } else if (roll < cfg.timeoutRate + cfg.failureRate) {
      outcome = 'FAILURE';
      error = 'Simulated WhatsApp API 503 service unavailable';
    }
  }

  if (outcome === 'SUCCESS') {
    const messageId = `wamid.${randomToken(12)}`;
    await prisma.mockWhatsAppMessage.createMany({
      data: [{ idempotencyKey, messageId, recipientMask: maskPhone(phone) }],
      skipDuplicates: true,
    });
    const saved = await prisma.mockWhatsAppMessage.findUniqueOrThrow({ where: { idempotencyKey } });
    return { outcome: 'SUCCESS', providerMessageId: saved.messageId, durationMs: Date.now() - start };
  }

  return { outcome, error, durationMs: Date.now() - start };
}

/**
 * Process one DeliveryJob idempotently.
 * - Uses atomic conditional update to claim the job (prevents concurrent double-sends).
 * - Checks certificate status first so cancelled certificates are never sent.
 * - Schedules exponential backoff on transient failures.
 */
export async function processDeliveryJob(jobId: string): Promise<{ status: string; outcome?: DeliveryOutcome }> {
  const retryCfg = await getConfig('delivery.retry');
  const now = new Date();
  const staleThreshold = new Date(Date.now() - 2 * 60_000);

  // Atomically claim the job if eligible
  const claimed = await prisma.deliveryJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: now } },
        // Reclaim jobs left in PROCESSING if a previous worker crashed
        { status: 'PROCESSING', lockedAt: { lt: staleThreshold } },
      ],
    },
    data: { status: 'PROCESSING', lockedAt: now },
  });

  if (claimed.count !== 1) {
    const cur = await prisma.deliveryJob.findUnique({ where: { id: jobId } });
    return { status: cur?.status ?? 'MISSING' };
  }

  const job = await prisma.deliveryJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { certificate: { include: { candidate: true, batch: true } } },
  });

  // Never deliver a cancelled certificate
  if (job.certificate.status === 'CANCELLED') {
    await prisma.deliveryJob.update({
      where: { id: job.id },
      data: { status: 'CANCELLED', lockedAt: null, lastError: 'Certificate was cancelled' },
    });
    return { status: 'CANCELLED', outcome: 'SKIPPED' };
  }

  const attemptNo = job.attempts + 1;
  const result = await invokeMockWhatsApp(job.certificate.candidate.phone, job.idempotencyKey, attemptNo);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.deliveryAttempt.createMany({
      data: [
        {
          jobId: job.id,
          attemptNo,
          outcome: result.outcome,
          error: result.error ?? null,
          durationMs: result.durationMs,
        },
      ],
      skipDuplicates: true,
    });

    if (result.outcome === 'SUCCESS') {
      const done = await tx.deliveryJob.update({
        where: { id: job.id },
        data: {
          status: 'SENT',
          attempts: attemptNo,
          lockedAt: null,
          lastError: null,
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
        },
      });
      await enqueueEvent(tx, {
        type: EVENTS.whatsappDeliveryCompleted,
        aggregateType: 'DeliveryJob',
        aggregateId: job.id,
        dedupeKey: `wa.sent:${job.id}:${attemptNo}`,
        payload: {
          jobId: job.id,
          certificateId: job.certificateId,
          batchId: job.certificate.batchId,
          districtId: job.certificate.batch.districtId,
          trainingCenterId: job.certificate.batch.trainingCenterId,
          status: 'SENT',
          attempts: attemptNo,
        },
      });
      return done;
    }

    const canRetry = attemptNo < job.maxAttempts;
    const backoffSeconds = retryCfg.baseSeconds * 2 ** (attemptNo - 1);
    const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);
    const nextStatus = canRetry ? 'RETRYING' : 'FAILED';

    const failed = await tx.deliveryJob.update({
      where: { id: job.id },
      data: {
        status: nextStatus,
        attempts: attemptNo,
        lockedAt: null,
        lastError: result.error ?? 'Delivery failed',
        nextAttemptAt,
      },
    });

    await enqueueEvent(tx, {
      type: EVENTS.whatsappDeliveryCompleted,
      aggregateType: 'DeliveryJob',
      aggregateId: job.id,
      dedupeKey: `wa.attempt:${job.id}:${attemptNo}`,
      payload: {
        jobId: job.id,
        certificateId: job.certificateId,
        batchId: job.certificate.batchId,
        districtId: job.certificate.batch.districtId,
        trainingCenterId: job.certificate.batch.trainingCenterId,
        status: nextStatus,
        attempts: attemptNo,
        lastError: failed.lastError,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });

    return failed;
  }, TX_OPTS);

  return { status: updated.status, outcome: result.outcome };
}

/** Sweep due RETRYING / PENDING / stale PROCESSING delivery jobs and enqueue them. */
export async function sweepDueDeliveryJobs(limit = 50): Promise<number> {
  const now = new Date();
  const stale = new Date(Date.now() - 2 * 60_000);
  const due = await prisma.deliveryJob.findMany({
    where: {
      OR: [
        { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: now } },
        { status: 'PROCESSING', lockedAt: { lt: stale } },
      ],
    },
    take: limit,
    orderBy: { nextAttemptAt: 'asc' },
    select: { id: true },
  });
  let processed = 0;
  for (const job of due) {
    await processDeliveryJob(job.id);
    processed++;
  }
  return processed;
}

/** Manual retry endpoint for authorized officers (State Officer / Super Admin). */
export async function manualRetryDeliveryJob(user: AuthUser, jobId: string, ip: string) {
  if (user.role !== 'STATE_OFFICER' && user.role !== 'SUPER_ADMIN') {
    throw forbidden('Only State Officers and Super Admins can manually retry deliveries');
  }

  const job = await prisma.deliveryJob.findFirst({
    where: { id: jobId, ...deliveryScope(user) },
    include: { certificate: { include: { batch: true } } },
  });
  if (!job) throw notFound('Delivery job not found');
  if (job.certificate.status === 'CANCELLED') throw conflict('Cannot retry delivery for a cancelled certificate');
  if (job.status === 'SENT') throw conflict('Delivery has already succeeded');

  const updated = await prisma.$transaction(async (tx) => {
    const reset = await tx.deliveryJob.update({
      where: { id: job.id },
      data: {
        status: 'RETRYING',
        maxAttempts: Math.max(job.maxAttempts, job.attempts + 2),
        nextAttemptAt: new Date(),
        lockedAt: null,
      },
    });
    await audit(
      {
        actor: user,
        action: 'delivery.retry.requested',
        resourceType: 'DeliveryJob',
        resourceId: job.id,
        batchId: job.certificate.batchId,
        ip,
      },
      tx,
    );
    await enqueueEvent(tx, {
      type: EVENTS.whatsappDeliveryRequested,
      aggregateType: 'DeliveryJob',
      aggregateId: job.id,
      payload: {
        jobId: job.id,
        certificateId: job.certificateId,
        batchId: job.certificate.batchId,
        districtId: job.certificate.batch.districtId,
        trainingCenterId: job.certificate.batch.trainingCenterId,
      },
    });
    return reset;
  }, TX_OPTS);

  return updated;
}
