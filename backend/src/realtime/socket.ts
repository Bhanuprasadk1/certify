import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { corsOrigins } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { resolveUserFromToken, type AuthUser } from '../services/auth.service.js';
import type { EventEnvelope, MessageBus } from '../bus/types.js';

let io: SocketServer | null = null;

/**
 * Socket.IO server with JWT authentication and strictly server-controlled rooms.
 * Clients CANNOT join arbitrary rooms — rooms are assigned solely from the verified identity.
 * Events contain only non-sensitive operational metadata (no candidate PII).
 */
export function attachRealtime(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: corsOrigins, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string | undefined) ||
        (socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '');
      if (!token) return next(new Error('Authentication required'));
      const user = await resolveUserFromToken(token);
      (socket.data as { user: AuthUser }).user = user;
      next();
    } catch {
      next(new Error('Invalid authentication token'));
    }
  });

  io.on('connection', (socket) => {
    const user = (socket.data as { user: AuthUser }).user;
    // Server-controlled room membership
    socket.join(`user:${user.id}`);
    socket.join(`role:${user.role}`);
    if (user.role === 'DISTRICT_OFFICER' && user.districtId) {
      socket.join(`district:${user.districtId}`);
    }
    if (user.role === 'TRAINING_CENTER' && user.trainingCenterId) {
      socket.join(`center:${user.trainingCenterId}`);
    }
    logger.debug('socket connected', { userId: user.id, role: user.role });

    // Explicitly reject any client attempt to join rooms
    socket.on('join', () => {
      socket.emit('error', { message: 'Room membership is server-controlled' });
    });
  });

  return io;
}

export function broadcastEvent(evt: EventEnvelope) {
  if (!io) return;
  const p = evt.payload as Record<string, unknown>;
  const rooms = new Set<string>(['role:SUPER_ADMIN', 'role:STATE_OFFICER']);

  if (typeof p.trainingCenterId === 'string') {
    rooms.add(`center:${p.trainingCenterId}`);
  }
  if (typeof p.districtId === 'string') {
    rooms.add(`district:${p.districtId}`);
  }
  if (p.requiresQuality === true || p.stage === 'QUALITY' || p.status === 'QUALITY_REVIEW' || evt.type === 'batch.quality.approved') {
    rooms.add('role:QUALITY_OFFICER');
  }

  // Strip any unexpected sensitive keys before emitting
  const safePayload = {
    eventId: evt.id,
    type: evt.type,
    aggregateType: evt.aggregateType,
    aggregateId: evt.aggregateId,
    occurredAt: evt.occurredAt,
    batchId: p.batchId,
    code: p.code,
    version: p.version,
    status: p.status,
    stage: p.stage,
    decision: p.decision,
    certificateId: p.certificateId,
    certificateNumber: p.certificateNumber,
    jobId: p.jobId,
    done: p.done,
    total: p.total,
    message: p.message,
  };

  let emitter = io.to([...rooms][0]);
  for (const r of [...rooms].slice(1)) emitter = emitter.to(r);
  emitter.emit('certiflow:event', safePayload);
}

export async function subscribeRealtimeToBus(bus: MessageBus) {
  await bus.subscribe(
    'cf.realtime.fanout',
    ['batch.#', 'certificate.#', 'whatsapp.#'],
    async (evt) => {
      broadcastEvent(evt);
    },
    { exclusive: true, prefetch: 50 },
  );
}
