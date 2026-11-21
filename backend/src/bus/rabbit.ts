import amqp from 'amqplib';
import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { logger } from '../lib/logger.js';
import { DLX, EXCHANGE, type EventEnvelope, type EventHandler, type MessageBus, type QueueStat, type SubscribeOptions } from './types.js';

interface Sub {
  queue: string;
  bindings: string[];
  handler: EventHandler;
  opts: SubscribeOptions;
}

/**
 * RabbitMQ transport: durable topic exchange, durable queues, persistent messages,
 * publisher confirms, manual acks, bounded retries and a dead-letter exchange.
 */
export class RabbitBus implements MessageBus {
  readonly driver = 'rabbitmq' as const;
  private conn: ChannelModel | null = null;
  private pubCh: ConfirmChannel | null = null;
  private consumeChannels: Channel[] = [];
  private subs: Sub[] = [];
  private connecting: Promise<void> | null = null;
  private closed = false;
  private durableQueues = new Set<string>();

  constructor(private url: string) {}

  async connect(): Promise<void> {
    if (this.conn) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let attempt = 0;
      while (!this.closed) {
        try {
          const conn = await amqp.connect(this.url);
          conn.on('error', (err) => logger.warn('rabbitmq connection error', { err: err.message }));
          conn.on('close', () => {
            if (this.closed) return;
            logger.warn('rabbitmq connection closed, reconnecting');
            this.conn = null;
            this.pubCh = null;
            this.consumeChannels = [];
            setTimeout(() => void this.connect().then(() => this.resubscribeAll()), 2000);
          });
          this.conn = conn;
          this.pubCh = await conn.createConfirmChannel();
          await this.pubCh.assertExchange(EXCHANGE, 'topic', { durable: true });
          await this.pubCh.assertExchange(DLX, 'direct', { durable: true });
          logger.info('rabbitmq connected');
          return;
        } catch (err) {
          attempt++;
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
          logger.warn('rabbitmq connect failed', { attempt, delay, err });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async publish(evt: EventEnvelope): Promise<void> {
    if (!this.pubCh) throw new Error('rabbitmq not connected');
    const ch = this.pubCh;
    await new Promise<void>((resolve, reject) => {
      ch.publish(EXCHANGE, evt.type, Buffer.from(JSON.stringify(evt)), {
        persistent: true,
        contentType: 'application/json',
        messageId: evt.id,
        type: evt.type,
        timestamp: Math.floor(Date.now() / 1000),
      }, (err) => (err ? reject(err) : resolve()));
    });
  }

  async subscribe(queue: string, bindings: string[], handler: EventHandler, opts: SubscribeOptions = {}): Promise<void> {
    const sub = { queue, bindings, handler, opts };
    this.subs.push(sub);
    await this.connect();
    await this.setupConsumer(sub);
  }

  private async resubscribeAll() {
    for (const s of this.subs) await this.setupConsumer(s).catch((err) => logger.error('resubscribe failed', { queue: s.queue, err }));
  }

  private async setupConsumer(sub: Sub) {
    if (!this.conn) return;
    const ch = await this.conn.createChannel();
    this.consumeChannels.push(ch);
    await ch.prefetch(sub.opts.prefetch ?? 10);
    const maxRetries = sub.opts.maxRetries ?? 3;
    if (sub.opts.exclusive) {
      const q = await ch.assertQueue('', { exclusive: true, autoDelete: true, durable: false });
      for (const b of sub.bindings) await ch.bindQueue(q.queue, EXCHANGE, b);
      await ch.consume(q.queue, (msg) => void this.onMessage(ch, sub, msg, maxRetries, q.queue), { noAck: false });
      return;
    }
    const dlq = `${sub.queue}.dlq`;
    await ch.assertQueue(dlq, { durable: true });
    await ch.bindQueue(dlq, DLX, sub.queue);
    await ch.assertQueue(sub.queue, { durable: true, deadLetterExchange: DLX, deadLetterRoutingKey: sub.queue });
    for (const b of sub.bindings) await ch.bindQueue(sub.queue, EXCHANGE, b);
    this.durableQueues.add(sub.queue);
    this.durableQueues.add(dlq);
    await ch.consume(sub.queue, (msg) => void this.onMessage(ch, sub, msg, maxRetries, sub.queue), { noAck: false });
    logger.info('consumer ready', { queue: sub.queue, bindings: sub.bindings });
  }

  private async onMessage(ch: Channel, sub: Sub, msg: ConsumeMessage | null, maxRetries: number, queueName: string) {
    if (!msg) return;
    let evt: EventEnvelope;
    try {
      evt = JSON.parse(msg.content.toString('utf8'));
    } catch {
      ch.nack(msg, false, false); // poison message -> DLQ
      return;
    }
    try {
      await sub.handler(evt);
      ch.ack(msg);
    } catch (err) {
      const retries = Number(msg.properties.headers?.['x-retry-count'] ?? 0);
      if (retries < maxRetries && !sub.opts.exclusive) {
        const delay = 1000 * 2 ** retries;
        logger.warn('handler failed, scheduling retry', { queue: queueName, type: evt.type, retries, err });
        setTimeout(() => {
          try {
            ch.sendToQueue(queueName, msg.content, {
              persistent: true,
              contentType: 'application/json',
              messageId: msg.properties.messageId,
              type: msg.properties.type,
              headers: { ...(msg.properties.headers ?? {}), 'x-retry-count': retries + 1 },
            });
            ch.ack(msg);
          } catch {
            ch.nack(msg, false, true);
          }
        }, delay);
      } else {
        logger.error('handler failed permanently, dead-lettering', { queue: queueName, type: evt.type, err });
        ch.nack(msg, false, false);
      }
    }
  }

  async queueStats(): Promise<QueueStat[]> {
    if (!this.conn) return [];
    const names = new Set<string>([...this.durableQueues, 'cf.certificate.generate', 'cf.certificate.generate.dlq', 'cf.whatsapp.delivery', 'cf.whatsapp.delivery.dlq']);
    const out: QueueStat[] = [];
    for (const q of names) {
      let ch: Channel | null = null;
      try {
        ch = await this.conn.createChannel();
        ch.on('error', () => undefined);
        const r = await ch.checkQueue(q);
        out.push({ queue: q, messages: r.messageCount, consumers: r.consumerCount });
      } catch {
        out.push({ queue: q, messages: -1, consumers: 0 });
      } finally {
        await ch?.close().catch(() => undefined);
      }
    }
    return out;
  }

  isConnected() {
    return !!this.conn && !!this.pubCh;
  }

  async close() {
    this.closed = true;
    for (const ch of this.consumeChannels) await ch.close().catch(() => undefined);
    await this.pubCh?.close().catch(() => undefined);
    await this.conn?.close().catch(() => undefined);
    this.conn = null;
  }
}
