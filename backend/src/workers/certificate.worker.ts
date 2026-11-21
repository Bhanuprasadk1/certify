import { fileURLToPath } from 'node:url';
import { closeBus, getBus, QUEUES, type MessageBus } from '../bus/index.js';
import { logger } from '../lib/logger.js';
import { pgPool, prisma } from '../lib/prisma.js';
import { generateCertificatesForBatch } from '../services/certificate.service.js';
import { registerShutdown, startHeartbeat } from './heartbeat.js';

export async function startCertificateWorker(bus: MessageBus) {
  const hb = startHeartbeat('certificate-worker', { queue: QUEUES.certificate.name });

  await bus.subscribe(
    QUEUES.certificate.name,
    [...QUEUES.certificate.bindings],
    async (evt) => {
      const batchId = String(evt.payload.batchId ?? evt.aggregateId ?? '');
      if (!batchId) return;
      logger.info('certificate worker processing batch', { eventId: evt.id, type: evt.type, batchId });
      const res = await generateCertificatesForBatch(batchId);
      logger.info('certificate worker batch finished', { batchId, ...res });
    },
    { prefetch: 2, maxRetries: 3 },
  );

  // Also sweep any APPROVED batches that may have missed an event on restart
  const sweep = setInterval(async () => {
    try {
      const pending = await prisma.batch.findMany({
        where: { status: { in: ['APPROVED', 'CERTIFICATE_PROCESSING'] } },
        take: 5,
        select: { id: true },
      });
      for (const b of pending) await generateCertificatesForBatch(b.id);
    } catch (err) {
      logger.warn('certificate sweep error', { err });
    }
  }, 15_000);
  sweep.unref();

  return async () => {
    clearInterval(sweep);
    await hb.stop();
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bus = await getBus();
  const stop = await startCertificateWorker(bus);
  logger.info('certificate worker started standalone');
  registerShutdown(async () => {
    await stop();
    await closeBus();
    await prisma.$disconnect();
    await pgPool.end();
  });
}
