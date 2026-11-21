import { env } from '../config/env.js';
import { MemoryBus } from './memory.js';
import { RabbitBus } from './rabbit.js';
import type { MessageBus } from './types.js';

let bus: MessageBus | null = null;

export async function getBus(): Promise<MessageBus> {
  if (bus) return bus;
  if (env.QUEUE_DRIVER === 'rabbitmq') {
    if (!env.RABBITMQ_URL) throw new Error('RABBITMQ_URL is required when QUEUE_DRIVER=rabbitmq');
    const rb = new RabbitBus(env.RABBITMQ_URL);
    bus = rb;
    await rb.connect();
  } else {
    bus = new MemoryBus();
  }
  return bus;
}

export function currentBus(): MessageBus | null {
  return bus;
}

export async function closeBus() {
  await bus?.close();
  bus = null;
}

export * from './types.js';
