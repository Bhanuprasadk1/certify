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

await ensureConfigDefaults();
const app = createApp();
const server = http.createServer(app);
attachRealtime(server);

const bus = await getBus();
await subscribeRealtimeToBus(bus);

server.listen(env.PORT, () => {
  logger.info('CertiFlow API listening', { port: env.PORT, queueDriver: bus.driver });
});

registerShutdown(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeBus();
  await closeRedis();
  await prisma.$disconnect();
  await pgPool.end();
});
