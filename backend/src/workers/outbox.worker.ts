import { fileURLToPath } from 'node:url';
import { closeBus, getBus, type MessageBus } from '../bus/index.js';
import { logger } from '../lib/logger.js';
import { pgPool, prisma } from '../lib/prisma.js';
import { publishPendingOutbox } from '../services/outbox.service.js';
import { registerShutdown, startHeartbeat } from './heartbeat.js';

export async function startOutboxWorker(bus: MessageBus) {
  const hb = startHeartbeat('outbox-publisher');
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const count = await publishPendingOutbox(bus, 100);
      if (count > 0) logger.debug('outbox published events', { count });
    } catch (err) {
      logger.warn('outbox tick error', { err });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await hb.stop();
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bus = await getBus();
  const stop = await startOutboxWorker(bus);
  logger.info('outbox publisher started standalone');
  registerShutdown(async () => {
    await stop();
    await closeBus();
    await prisma.$disconnect();
    await pgPool.end();
  });
}
