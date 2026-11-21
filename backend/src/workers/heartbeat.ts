import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export function startHeartbeat(workerName: string, info?: Prisma.InputJsonValue) {
  const beat = async (status: string) => {
    try {
      await prisma.workerHeartbeat.upsert({
        where: { name: workerName },
        update: { status, lastBeatAt: new Date(), ...(info ? { info } : {}) },
        create: { name: workerName, status, info },
      });
    } catch (err) {
      logger.debug('heartbeat write failed', { workerName, err });
    }
  };
  void beat('running');
  const timer = setInterval(() => void beat('running'), 15_000);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await beat('stopped');
    },
  };
}

export function registerShutdown(cleanup: () => Promise<void>) {
  let stopping = false;
  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('graceful shutdown started', { sig });
    void cleanup()
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error('shutdown error', { err });
        process.exit(1);
      });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}
