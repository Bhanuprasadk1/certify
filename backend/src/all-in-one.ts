import http from 'node:http';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { attachRealtime, subscribeRealtimeToBus } from './realtime/socket.js';
import { closeBus, getBus } from './bus/index.js';
import { closeRedis } from './lib/redis.js';
import { pgPool, prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { ensureConfigDefaults } from './services/config.service.js';
import { registerShutdown } from './workers/heartbeat.js';
import { startCertificateWorker } from './workers/certificate.worker.js';
import { startDeliveryWorker } from './workers/delivery.worker.js';
import { startOutboxWorker } from './workers/outbox.worker.js';
import { startSchedulerWorker } from './workers/scheduler.worker.js';

await ensureConfigDefaults();
const app = createApp();
const server = http.createServer(app);
attachRealtime(server);

const bus = await getBus();
await subscribeRealtimeToBus(bus);

const stopCert = await startCertificateWorker(bus);
const stopDelivery = await startDeliveryWorker(bus);
const stopOutbox = await startOutboxWorker(bus);
const stopScheduler = await startSchedulerWorker();

server.listen(env.PORT, () => {
  logger.info('CertiFlow all-in-one server listening', { port: env.PORT, queueDriver: bus.driver });
});

registerShutdown(async () => {
  await stopScheduler();
  await stopOutbox();
  await stopDelivery();
  await stopCert();
  await new Promise<void>((r) => server.close(() => r()));
  await closeBus();
  await closeRedis();
  await prisma.$disconnect();
  await pgPool.end();
});
