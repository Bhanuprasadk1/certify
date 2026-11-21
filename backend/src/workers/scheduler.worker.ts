import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { pgPool, prisma } from '../lib/prisma.js';
import { scanStuckBatches } from '../services/escalation.service.js';
import { registerShutdown, startHeartbeat } from './heartbeat.js';

export async function startSchedulerWorker() {
  const hb = startHeartbeat('escalation-scheduler');
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const res = await scanStuckBatches();
      if (res.created > 0) logger.info('escalation scheduler created escalations', res);
    } catch (err) {
      logger.warn('escalation scheduler error', { err });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 30_000);
  timer.unref();

  return async () => {
    clearInterval(timer);
    await hb.stop();
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stop = await startSchedulerWorker();
  logger.info('escalation scheduler started standalone');
  registerShutdown(async () => {
    await stop();
    await prisma.$disconnect();
    await pgPool.end();
  });
}
