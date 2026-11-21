import type { BatchStatus, RoleCode } from '@prisma/client';
import { prisma, TX_OPTS } from '../lib/prisma.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { EVENTS } from '../bus/types.js';
import { audit } from './audit.service.js';
import { getConfig } from './config.service.js';
import { enqueueEvent } from './outbox.service.js';
import type { AuthUser } from './auth.service.js';

const REVIEW_STAGES: { status: BatchStatus; slaKey: 'DISTRICT_REVIEW' | 'QUALITY_REVIEW' | 'STATE_REVIEW'; role: RoleCode }[] = [
  { status: 'DISTRICT_REVIEW', slaKey: 'DISTRICT_REVIEW', role: 'DISTRICT_OFFICER' },
  { status: 'QUALITY_REVIEW', slaKey: 'QUALITY_REVIEW', role: 'QUALITY_OFFICER' },
  { status: 'STATE_REVIEW', slaKey: 'STATE_REVIEW', role: 'STATE_OFFICER' },
];

/**
 * Scan review queues for batches exceeding the configured SLA.
 * Unique constraint (batchId, version, stage) guarantees no duplicate escalations when the scheduler repeats.
 */
export async function scanStuckBatches(): Promise<{ scanned: number; created: number }> {
  const sla = await getConfig('sla.minutes');
  const now = Date.now();
  let scanned = 0;
  let created = 0;

  for (const stage of REVIEW_STAGES) {
    const slaMinutes = sla[stage.slaKey];
    const cutoff = new Date(now - slaMinutes * 60_000);
    const stuck = await prisma.batch.findMany({
      where: { status: stage.status, stageEnteredAt: { lte: cutoff } },
      include: { district: true, trainingCenter: true },
    });
    scanned += stuck.length;

    for (const batch of stuck) {
      const elapsedMinutes = Math.max(slaMinutes, Math.floor((now - batch.stageEnteredAt.getTime()) / 60_000));
      const inserted = await prisma.$transaction(async (tx) => {
        const res = await tx.batchEscalation.createMany({
          data: [
            {
              batchId: batch.id,
              version: batch.version,
              stage: batch.status,
              status: 'OPEN',
              responsibleRole: stage.role,
              elapsedMinutes,
              slaMinutes,
              message: `Batch ${batch.code} (${batch.title}) has been pending in ${batch.status} for ${elapsedMinutes}m (SLA: ${slaMinutes}m)`,
            },
          ],
          skipDuplicates: true,
        });
        if (res.count !== 1) return false;

        const esc = await tx.batchEscalation.findUniqueOrThrow({
          where: { batchId_version_stage: { batchId: batch.id, version: batch.version, stage: batch.status } },
        });

        await audit(
          {
            action: 'batch.escalated',
            resourceType: 'BatchEscalation',
            resourceId: esc.id,
            batchId: batch.id,
            metadata: { stage: batch.status, version: batch.version, elapsedMinutes, slaMinutes },
          },
          tx,
        );

        await enqueueEvent(tx, {
          type: EVENTS.batchEscalated,
          aggregateType: 'BatchEscalation',
          aggregateId: esc.id,
          dedupeKey: `batch.escalated:${batch.id}:v${batch.version}:${batch.status}`,
          payload: {
            escalationId: esc.id,
            batchId: batch.id,
            code: batch.code,
            stage: batch.status,
            elapsedMinutes,
            slaMinutes,
            districtId: batch.districtId,
            trainingCenterId: batch.trainingCenterId,
            message: esc.message,
          },
        });
        return true;
      }, TX_OPTS);

      if (inserted) created++;
    }
  }

  return { scanned, created };
}

/**
 * Demo helper: backdate a pending batch's stageEnteredAt past its SLA and run the escalation scan immediately.
 * Authorized only for STATE_OFFICER and SUPER_ADMIN.
 */
export async function simulateStuckBatch(user: AuthUser, batchId: string, ip: string) {
  if (user.role !== 'STATE_OFFICER' && user.role !== 'SUPER_ADMIN') {
    throw forbidden('Only State Officers and Super Admins can simulate stuck batches');
  }
  const sla = await getConfig('sla.minutes');
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) throw notFound('Batch not found');
  if (batch.status !== 'DISTRICT_REVIEW' && batch.status !== 'QUALITY_REVIEW' && batch.status !== 'STATE_REVIEW') {
    throw conflict(`Only batches in a review stage can be simulated as stuck (current: ${batch.status})`);
  }

  const slaMin = sla[batch.status];
  const backdated = new Date(Date.now() - (slaMin + 25) * 60_000);
  await prisma.batch.update({ where: { id: batchId }, data: { stageEnteredAt: backdated } });
  await audit(
    {
      actor: user,
      action: 'batch.stuck.simulated',
      resourceType: 'Batch',
      resourceId: batchId,
      batchId,
      metadata: { stage: batch.status, backdatedMinutes: slaMin + 25 },
      ip,
    },
  );

  const scan = await scanStuckBatches();
  const escalation = await prisma.batchEscalation.findUnique({
    where: { batchId_version_stage: { batchId: batch.id, version: batch.version, stage: batch.status } },
  });
  return { scan, escalation };
}

export async function updateEscalationStatus(
  user: AuthUser,
  escalationId: string,
  status: 'ACKNOWLEDGED' | 'RESOLVED',
  resolution: string | undefined,
  ip: string,
) {
  if (user.role !== 'STATE_OFFICER' && user.role !== 'SUPER_ADMIN') {
    throw forbidden('Only State Officers and Super Admins can update escalations');
  }
  const esc = await prisma.batchEscalation.findUnique({ where: { id: escalationId } });
  if (!esc) throw notFound('Escalation not found');

  const updated = await prisma.batchEscalation.update({
    where: { id: escalationId },
    data: {
      status,
      resolution: resolution?.trim() || esc.resolution,
      ...(status === 'RESOLVED' ? { resolvedAt: new Date(), resolvedById: user.id } : {}),
    },
  });

  await audit({
    actor: user,
    action: `escalation.${status.toLowerCase()}`,
    resourceType: 'BatchEscalation',
    resourceId: escalationId,
    batchId: esc.batchId,
    reason: resolution?.trim() || null,
    ip,
  });

  return updated;
}
