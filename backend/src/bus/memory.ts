import { logger } from '../lib/logger.js';
import { topicMatches, type EventEnvelope, type EventHandler, type MessageBus, type QueueStat, type SubscribeOptions } from './types.js';

interface Sub {
  queue: string;
  bindings: string[];
  handler: EventHandler;
  maxRetries: number;
  pending: number;
  dlq: EventEnvelope[];
}

/**
 * In-process bus used for local single-process mode and tests.
 * Mirrors the RabbitMQ semantics that matter: topic routing, retries, dead-lettering.
 */
export class MemoryBus implements MessageBus {
  readonly driver = 'memory' as const;
  private subs: Sub[] = [];
  private closed = false;

  async publish(evt: EventEnvelope): Promise<void> {
    if (this.closed) throw new Error('bus closed');
    for (const sub of this.subs) {
      if (!sub.bindings.some((b) => topicMatches(b, evt.type))) continue;
      sub.pending++;
      setImmediate(() => void this.deliver(sub, evt, 0));
    }
  }

  private async deliver(sub: Sub, evt: EventEnvelope, attempt: number): Promise<void> {
    try {
      await sub.handler(evt);
      sub.pending--;
    } catch (err) {
      if (attempt < sub.maxRetries && !this.closed) {
        const delay = 500 * 2 ** attempt;
        logger.warn('memory bus handler failed, retrying', { queue: sub.queue, type: evt.type, attempt, err });
        setTimeout(() => void this.deliver(sub, evt, attempt + 1), delay);
      } else {
        sub.pending--;
        sub.dlq.push(evt);
        logger.error('memory bus message dead-lettered', { queue: sub.queue, type: evt.type, err });
      }
    }
  }

  async subscribe(queue: string, bindings: string[], handler: EventHandler, opts?: SubscribeOptions): Promise<void> {
    this.subs.push({ queue, bindings, handler, maxRetries: opts?.maxRetries ?? 3, pending: 0, dlq: [] });
  }

  async queueStats(): Promise<QueueStat[]> {
    return this.subs.flatMap((s) => [
      { queue: s.queue, messages: s.pending, consumers: 1 },
      { queue: `${s.queue}.dlq`, messages: s.dlq.length, consumers: 0 },
    ]);
  }

  isConnected() {
    return !this.closed;
  }

  async close() {
    this.closed = true;
  }
}
