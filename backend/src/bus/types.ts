export interface EventEnvelope<T = Record<string, unknown>> {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: T;
  occurredAt: string;
}

export type EventHandler = (evt: EventEnvelope) => Promise<void>;

export interface SubscribeOptions {
  prefetch?: number;
  /** Exclusive, auto-delete queue (e.g. per-API-instance realtime fan-out). */
  exclusive?: boolean;
  maxRetries?: number;
}

export interface QueueStat {
  queue: string;
  messages: number;
  consumers: number;
}

export interface MessageBus {
  readonly driver: 'rabbitmq' | 'memory';
  publish(evt: EventEnvelope): Promise<void>;
  subscribe(queue: string, bindings: string[], handler: EventHandler, opts?: SubscribeOptions): Promise<void>;
  queueStats(): Promise<QueueStat[]>;
  isConnected(): boolean;
  close(): Promise<void>;
}

export const EXCHANGE = 'certiflow.events';
export const DLX = 'certiflow.dlx';

export const QUEUES = {
  certificate: { name: 'cf.certificate.generate', bindings: ['batch.state.approved', 'certificate.generate.requested'] },
  delivery: { name: 'cf.whatsapp.delivery', bindings: ['whatsapp.delivery.requested'] },
} as const;

export const EVENTS = {
  batchSubmitted: 'batch.submitted',
  batchResubmitted: 'batch.resubmitted',
  approvalRecorded: 'batch.approval.recorded',
  batchDistrictApproved: 'batch.district.approved',
  batchQualityApproved: 'batch.quality.approved',
  batchStateApproved: 'batch.state.approved',
  batchReturned: 'batch.returned',
  batchRejected: 'batch.rejected',
  batchWithdrawn: 'batch.withdrawn',
  certificateGenerateRequested: 'certificate.generate.requested',
  certificateProgress: 'certificate.generation.progress',
  certificateGenerated: 'certificate.generated',
  whatsappDeliveryRequested: 'whatsapp.delivery.requested',
  whatsappDeliveryCompleted: 'whatsapp.delivery.completed',
  certificateCancelled: 'certificate.cancelled',
  batchEscalated: 'batch.escalated',
} as const;

/** AMQP topic pattern match: `*` = one word, `#` = zero or more words. */
export function topicMatches(pattern: string, key: string): boolean {
  const p = pattern.split('.');
  const k = key.split('.');
  const rec = (i: number, j: number): boolean => {
    if (i === p.length) return j === k.length;
    if (p[i] === '#') {
      for (let n = j; n <= k.length; n++) if (rec(i + 1, n)) return true;
      return false;
    }
    if (j === k.length) return false;
    return (p[i] === '*' || p[i] === k[j]) && rec(i + 1, j + 1);
  };
  return rec(0, 0);
}
