import { fileURLToPath } from 'node:url';
import { closeBus, getBus, QUEUES, type MessageBus } from '../bus/index.js';
import { logger } from '../lib/logger.js';
import { pgPool, prisma } from '../lib/prisma.js';
import { processDeliveryJob, sweepDueDeliveryJobs } from '../services/delivery.service.js';
import { registerShutdown, startHeartbeat } from './heartbeat.js';

export async function startDeliveryWorker(bus: MessageBus) {
  const hb = startHeartbeat('delivery-worker', { queue: QUEUES.delivery.name });

  await bus.subscribe(
    QUEUES.delivery.name,
    [...QUEUES.delivery.bindings],
    async (evt) => {
      const jobId = String(evt.payload.jobId ?? evt.aggregateId ?? '');
      if (!jobId) return;
      const res = await processDeliveryJob(jobId);
      logger.debug('delivery job processed', { jobId, ...res });
    },
    { prefetch: 10, maxRetries: 3 },
  );

  // Periodic sweep processes scheduled retries after their exponential backoff elapses
  const sweep = setInterval(async () => {
    try {
      const count = await sweepDueDeliveryJobs(30);
      if (count > 0) logger.debug('delivery retry sweep processed jobs', { count });
    } catch (err) {
      logger.warn('delivery sweep error', { err });
    }
  }, 5_000);
  sweep.unref();

  return async () => {
    clearInterval(sweep);
    await hb.stop();
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bus = await getBus();
  const stop = await startDeliveryWorker(bus);
  logger.info('delivery worker started standalone');
  registerShutdown(async () => {
    await stop();
    await closeBus();
    await prisma.$disconnect();
    await pgPool.end();
  });
}
