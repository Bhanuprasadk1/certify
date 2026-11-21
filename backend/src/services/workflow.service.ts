import type { BatchStatus, Decision, Prisma, ReviewStage } from '@prisma/client';
import { prisma, lockBatch, TX_OPTS, isUniqueViolation } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { EVENTS } from '../bus/types.js';
import { audit } from './audit.service.js';
import { getConfig } from './config.service.js';
import { enqueueEvent } from './outbox.service.js';
import type { AuthUser } from './auth.service.js';
import type { ParsedCandidateRow } from './csv.service.js';

/**
 * Explicit finite-state machine for Batch status transitions.
 * Every status change goes through this service — never arbitrary PATCH from clients.
 */
export const ALLOWED_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  DRAFT: ['SUBMITTED', 'DISTRICT_REVIEW', 'CANCELLED'],
  SUBMITTED: ['DISTRICT_REVIEW', 'RETURNED', 'REJECTED'],
  DISTRICT_REVIEW: ['QUALITY_REVIEW', 'STATE_REVIEW', 'RETURNED', 'REJECTED'],
  QUALITY_REVIEW: ['STATE_REVIEW', 'RETURNED', 'REJECTED'],
  STATE_REVIEW: ['APPROVED', 'RETURNED', 'REJECTED'],
  APPROVED: ['CERTIFICATE_PROCESSING'],
  CERTIFICATE_PROCESSING: ['CERTIFICATES_ISSUED'],
  CERTIFICATES_ISSUED: [],
  RETURNED: ['DISTRICT_REVIEW', 'CANCELLED'],
  REJECTED: [], // Terminal: requires creating a new batch
  CANCELLED: [], // Terminal
};

function assertTransition(from: BatchStatus, to: BatchStatus) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw conflict(`Invalid workflow transition from ${from} to ${to}`);
  }
}

function generateBatchCode(centerCode: string): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PSM-${centerCode}-${ym}-${rand}`;
}

export async function createBatch(
  user: AuthUser,
  input: { title: string; courseName: string; courseCode: string; startDate?: Date | null; completionDate: Date },
  ip: string,
) {
  if (user.role !== 'TRAINING_CENTER' || !user.trainingCenterId) {
    throw forbidden('Only a Training Center user can create a batch');
  }
  const center = await prisma.trainingCenter.findUnique({ where: { id: user.trainingCenterId } });
  if (!center) throw forbidden('Assigned training center not found');

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.batch.create({
      data: {
        code: generateBatchCode(center.code),
        title: input.title.trim(),
        courseName: input.courseName.trim(),
        courseCode: input.courseCode.trim().toUpperCase(),
        trainingCenterId: center.id,
        districtId: center.districtId, // Always derived server-side from center
        startDate: input.startDate ?? null,
        completionDate: input.completionDate,
        status: 'DRAFT',
        version: 1,
        createdById: user.id,
      },
      include: { district: true, trainingCenter: true },
    });
    await audit(
      {
        actor: user,
        action: 'batch.created',
        resourceType: 'Batch',
        resourceId: created.id,
        batchId: created.id,
        metadata: { code: created.code, courseName: created.courseName },
        ip,
      },
      tx,
    );
    return created;
  }, TX_OPTS);

  return batch;
}

export async function updateBatch(
  user: AuthUser,
  batchId: string,
  input: { title?: string; courseName?: string; courseCode?: string; startDate?: Date | null; completionDate?: Date },
  ip: string,
) {
  if (user.role !== 'TRAINING_CENTER') throw forbidden('Only Training Center users can edit batches');

  return prisma.$transaction(async (tx) => {
    const locked = await lockBatch(tx, batchId);
    if (!locked) throw notFound('Batch not found');
    const batch = await tx.batch.findUniqueOrThrow({ where: { id: batchId } });
    if (batch.trainingCenterId !== user.trainingCenterId) throw forbidden('You do not own this batch');
    if (batch.status !== 'DRAFT' && batch.status !== 'RETURNED') {
      throw conflict(`Batch in status ${batch.status} cannot be edited`);
    }

    const updated = await tx.batch.update({
      where: { id: batchId },
      data: {
        ...(input.title ? { title: input.title.trim() } : {}),
        ...(input.courseName ? { courseName: input.courseName.trim() } : {}),
        ...(input.courseCode ? { courseCode: input.courseCode.trim().toUpperCase() } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.completionDate ? { completionDate: input.completionDate } : {}),
      },
      include: { district: true, trainingCenter: true },
    });

    await audit(
      {
        actor: user,
        action: 'batch.updated',
        resourceType: 'Batch',
        resourceId: batchId,
        batchId,
        metadata: { version: batch.version },
        ip,
      },
      tx,
    );
    return updated;
  }, TX_OPTS);
}

/**
 * Atomic replacement of candidates for a DRAFT or RETURNED batch.
 * Called only after full CSV/Excel validation succeeds.
 */
export async function replaceBatchCandidates(
  user: AuthUser,
  batchId: string,
  candidates: ParsedCandidateRow[],
  ip: string,
) {
  if (user.role !== 'TRAINING_CENTER') throw forbidden('Only Training Center users can upload candidates');
  if (!candidates.length) throw unprocessable('At least one valid candidate is required');

  const threshold = await getConfig('quality.threshold');

  return prisma.$transaction(async (tx) => {
    const locked = await lockBatch(tx, batchId);
    if (!locked) throw notFound('Batch not found');
    const batch = await tx.batch.findUniqueOrThrow({ where: { id: batchId } });
    if (batch.trainingCenterId !== user.trainingCenterId) throw forbidden('You do not own this batch');
    if (batch.status !== 'DRAFT' && batch.status !== 'RETURNED') {
      throw conflict(`Cannot upload candidates when batch is in status ${batch.status}`);
    }

    await tx.candidate.deleteMany({ where: { batchId } });
    await tx.candidate.createMany({
      data: candidates.map((c) => ({
        batchId,
        rowNumber: c.rowNumber,
        externalId: c.externalId,
        name: c.name,
        email: c.email,
        phone: c.phone,
        courseName: c.courseName,
        completionDate: c.completionDate,
      })),
    });

    const updated = await tx.batch.update({
      where: { id: batchId },
      data: {
        candidateCount: candidates.length,
        requiresQuality: candidates.length >= threshold,
      },
    });

    await audit(
      {
        actor: user,
        action: 'batch.candidates.uploaded',
        resourceType: 'Batch',
        resourceId: batchId,
        batchId,
        metadata: { count: candidates.length, requiresQuality: updated.requiresQuality },
        ip,
      },
      tx,
    );
    return updated;
  }, TX_OPTS);
}

/** Submit a DRAFT batch into DISTRICT_REVIEW (via SUBMITTED -> DISTRICT_REVIEW atomically). */
export async function submitBatch(user: AuthUser, batchId: string, ip: string) {
  if (user.role !== 'TRAINING_CENTER') throw forbidden('Only Training Center users can submit batches');
  const threshold = await getConfig('quality.threshold');

  return prisma.$transaction(async (tx) => {
    const locked = await lockBatch(tx, batchId);
    if (!locked) throw notFound('Batch not found');
    const batch = await tx.batch.findUniqueOrThrow({
      where: { id: batchId },
      include: { _count: { select: { candidates: true } } },
    });
    if (batch.trainingCenterId !== user.trainingCenterId) throw forbidden('You do not own this batch');
    if (batch.status !== 'DRAFT') throw conflict(`Batch cannot be submitted from status ${batch.status}`);
    if (batch._count.candidates < 1) throw badRequest('Upload at least one valid candidate before submitting');

    assertTransition(batch.status, 'DISTRICT_REVIEW');
    const now = new Date();
    const requiresQuality = batch._count.candidates >= threshold;

    const updated = await tx.batch.update({
      where: { id: batchId },
      data: {
        status: 'DISTRICT_REVIEW',
        candidateCount: batch._count.candidates,
        requiresQuality,
        submittedAt: now,
        stageEnteredAt: now,
        returnReason: null,
      },
      include: { district: true, trainingCenter: true },
    });

    await audit(
      {
        actor: user,
        action: 'batch.submitted',
        resourceType: 'Batch',
        resourceId: batchId,
        batchId,
        metadata: { version: updated.version, candidateCount: updated.candidateCount, requiresQuality },
        ip,
      },
      tx,
    );

    await enqueueEvent(tx, {
      type: EVENTS.batchSubmitted,
      aggregateType: 'Batch',
      aggregateId: batchId,
      dedupeKey: `batch.submitted:${batchId}:v${updated.version}`,
      payload: {
        batchId,
        code: updated.code,
        version: updated.version,
        districtId: updated.districtId,
        trainingCenterId: updated.trainingCenterId,
        candidateCount: updated.candidateCount,
        requiresQuality,
        status: updated.status,
      },
    });

    return updated;
  }, TX_OPTS);
}

/**
 * Resubmit a RETURNED batch.
 * Policy: increment batch version so prior approvals stay in audit history but do NOT count for the new version.
 */
export async function resubmitBatch(user: AuthUser, batchId: string, ip: string) {
  if (user.role !== 'TRAINING_CENTER') throw forbidden('Only Training Center users can resubmit batches');
  const threshold = await getConfig('quality.threshold');

  return prisma.$transaction(async (tx) => {
    const locked = await lockBatch(tx, batchId);
    if (!locked) throw notFound('Batch not found');
    const batch = await tx.batch.findUniqueOrThrow({
      where: { id: batchId },
      include: { _count: { select: { candidates: true } } },
    });
    if (batch.trainingCenterId !== user.trainingCenterId) throw forbidden('You do not own this batch');
    if (batch.status !== 'RETURNED') throw conflict(`Only RETURNED batches can be resubmitted (current: ${batch.status})`);
    if (batch._count.candidates < 1) throw badRequest('Batch must contain at least one candidate');

    assertTransition(batch.status, 'DISTRICT_REVIEW');
    const now = new Date();
    const newVersion = batch.version + 1;
    const requiresQuality = batch._count.candidates >= threshold;

    const updated = await tx.batch.update({
      where: { id: batchId },
      data: {
        status: 'DISTRICT_REVIEW',
        version: newVersion,
        candidateCount: batch._count.candidates,
        requiresQuality,
        submittedAt: now,
        stageEnteredAt: now,
        returnReason: null,
      },
      include: { district: true, trainingCenter: true },
    });

    await audit(
      {
        actor: user,
        action: 'batch.resubmitted',
        resourceType: 'Batch',
        resourceId: batchId,
        batchId,
        metadata: { previousVersion: batch.version, version: newVersion, candidateCount: updated.candidateCount },
        ip,
      },
      tx,
    );

    await enqueueEvent(tx, {
      type: EVENTS.batchResubmitted,
      aggregateType: 'Batch',
      aggregateId: batchId,
      dedupeKey: `batch.resubmitted:${batchId}:v${newVersion}`,
      payload: {
        batchId,
        code: updated.code,
        version: newVersion,
        districtId: updated.districtId,
        trainingCenterId: updated.trainingCenterId,
        candidateCount: updated.candidateCount,
        status: updated.status,
      },
    });

    return updated;
  }, TX_OPTS);
}

/**
 * Concurrency-safe review decision for District, Quality, and State stages.
 * Uses SELECT ... FOR UPDATE on the Batch row plus the DB unique constraint
 * (batchId, version, stage, reviewerId) to guarantee:
 * - No reviewer can approve the same batch version twice.
 * - Two concurrent district approvals both record cleanly, and the stage transition fires ONCE.
 */
export async function recordReviewDecision(
  user: AuthUser,
  batchId: string,
  stage: ReviewStage,
  decision: Decision,
  reason: string | undefined,
  ip: string,
) {
  if ((decision === 'RETURN' || decision === 'REJECT') && (!reason || reason.trim().length < 5)) {
    throw badRequest(`A reason of at least 5 characters is mandatory when choosing ${decision}`);
  }

  // Role check per stage
  const requiredRole: Record<ReviewStage, AuthUser['role']> = {
    DISTRICT: 'DISTRICT_OFFICER',
    QUALITY: 'QUALITY_OFFICER',
    STATE: 'STATE_OFFICER',
  };
  if (user.role !== requiredRole[stage]) {
    throw forbidden(`Only ${requiredRole[stage]} users can record a ${stage} review decision`);
  }

  const requiredDistrictApprovals = await getConfig('district.requiredApprovals');

  try {
    return await prisma.$transaction(async (tx) => {
      // Acquire row-level lock first so concurrent approvals serialize cleanly.
      const locked = await lockBatch(tx, batchId);
      if (!locked) throw notFound('Batch not found');

      const batch = await tx.batch.findUniqueOrThrow({
        where: { id: batchId },
        include: { district: true, trainingCenter: true },
      });

      // Stage-specific authorization & invariants
      if (stage === 'DISTRICT') {
        if (batch.districtId !== user.districtId) {
          throw forbidden('You cannot review batches outside your assigned district');
        }
        // Conflict of interest: officer affiliated with the submitting training center
        if (
          (user.affiliatedTrainingCenterId && user.affiliatedTrainingCenterId === batch.trainingCenterId) ||
          (user.trainingCenterId && user.trainingCenterId === batch.trainingCenterId) ||
          batch.createdById === user.id
        ) {
          throw forbidden('Conflict of interest: you cannot review a batch from your affiliated training center');
        }
        if (batch.status !== 'DISTRICT_REVIEW') {
          throw conflict(`Batch is not awaiting district review (current status: ${batch.status})`);
        }
      } else if (stage === 'QUALITY') {
        if (batch.status !== 'QUALITY_REVIEW') {
          throw conflict(`Batch is not awaiting quality review (current status: ${batch.status})`);
        }
      } else if (stage === 'STATE') {
        if (batch.status !== 'STATE_REVIEW') {
          throw conflict(`Batch is not awaiting state approval (current status: ${batch.status})`);
        }
        // Verify prerequisite approvals exist for the CURRENT batch version
        const distApprovals = await tx.batchApproval.count({
          where: { batchId, version: batch.version, stage: 'DISTRICT', decision: 'APPROVE' },
        });
        if (distApprovals < requiredDistrictApprovals) {
          throw conflict(
            `Cannot finalize state review: requires ${requiredDistrictApprovals} district approvals for v${batch.version}, found ${distApprovals}`,
          );
        }
        if (batch.requiresQuality) {
          const qualApprovals = await tx.batchApproval.count({
            where: { batchId, version: batch.version, stage: 'QUALITY', decision: 'APPROVE' },
          });
          if (qualApprovals < 1) {
            throw conflict(`Cannot finalize state review: quality approval missing for v${batch.version}`);
          }
        }
      }

      // Prevent duplicate decision by same officer on same version + stage
      const existing = await tx.batchApproval.findUnique({
        where: {
          batchId_version_stage_reviewerId: {
            batchId,
            version: batch.version,
            stage,
            reviewerId: user.id,
          },
        },
      });
      if (existing) {
        throw conflict(`You have already submitted a ${stage.toLowerCase()} decision for batch v${batch.version}`);
      }

      const approval = await tx.batchApproval.create({
        data: {
          batchId,
          version: batch.version,
          stage,
          decision,
          reviewerId: user.id,
          reason: reason?.trim() || null,
        },
      });

      const now = new Date();
      let nextStatus: BatchStatus = batch.status;
      let progressed = false;
      const updateData: Prisma.BatchUpdateInput = {};

      if (decision === 'RETURN') {
        nextStatus = 'RETURNED';
        assertTransition(batch.status, nextStatus);
        updateData.status = nextStatus;
        updateData.returnReason = reason!.trim();
        updateData.stageEnteredAt = now;
        progressed = true;
      } else if (decision === 'REJECT') {
        nextStatus = 'REJECTED';
        assertTransition(batch.status, nextStatus);
        updateData.status = nextStatus;
        updateData.rejectReason = reason!.trim();
        updateData.stageEnteredAt = now;
        progressed = true;
      } else {
        // APPROVE
        if (stage === 'DISTRICT') {
          const count = await tx.batchApproval.count({
            where: { batchId, version: batch.version, stage: 'DISTRICT', decision: 'APPROVE' },
          });
          if (count >= requiredDistrictApprovals) {
            nextStatus = batch.requiresQuality ? 'QUALITY_REVIEW' : 'STATE_REVIEW';
            assertTransition(batch.status, nextStatus);
            updateData.status = nextStatus;
            updateData.stageEnteredAt = now;
            progressed = true;
          }
        } else if (stage === 'QUALITY') {
          nextStatus = 'STATE_REVIEW';
          assertTransition(batch.status, nextStatus);
          updateData.status = nextStatus;
          updateData.stageEnteredAt = now;
          progressed = true;
        } else if (stage === 'STATE') {
          nextStatus = 'APPROVED';
          assertTransition(batch.status, nextStatus);
          updateData.status = nextStatus;
          updateData.approvedAt = now;
          updateData.stageEnteredAt = now;
          progressed = true;
        }
      }

      const updated = progressed
        ? await tx.batch.update({
            where: { id: batchId },
            data: updateData,
            include: { district: true, trainingCenter: true },
          })
        : batch;

      // Auto-resolve any open escalations for the stage that just progressed
      if (progressed) {
        await tx.batchEscalation.updateMany({
          where: { batchId, version: batch.version, stage: batch.status, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          data: { status: 'RESOLVED', resolvedAt: now, resolvedById: user.id, resolution: `Batch moved to ${nextStatus}` },
        });
      }

      await audit(
        {
          actor: user,
          action: `batch.${stage.toLowerCase()}.${decision.toLowerCase()}`,
          resourceType: 'Batch',
          resourceId: batchId,
          batchId,
          reason: reason?.trim() || null,
          metadata: {
            version: batch.version,
            previousStatus: batch.status,
            nextStatus,
            progressed,
          },
          ip,
        },
        tx,
      );

      const basePayload = {
        batchId,
        code: batch.code,
        version: batch.version,
        stage,
        decision,
        status: nextStatus,
        districtId: batch.districtId,
        trainingCenterId: batch.trainingCenterId,
        requiresQuality: batch.requiresQuality,
        reason: reason?.trim() || null,
      };

      // Emit granular approval event for real-time UI
      await enqueueEvent(tx, {
        type: EVENTS.approvalRecorded,
        aggregateType: 'Batch',
        aggregateId: batchId,
        dedupeKey: `approval:${approval.id}`,
        payload: basePayload,
      });

      if (progressed) {
        if (decision === 'RETURN') {
          await enqueueEvent(tx, {
            type: EVENTS.batchReturned,
            aggregateType: 'Batch',
            aggregateId: batchId,
            dedupeKey: `batch.returned:${batchId}:v${batch.version}:${stage}`,
            payload: basePayload,
          });
        } else if (decision === 'REJECT') {
          await enqueueEvent(tx, {
            type: EVENTS.batchRejected,
            aggregateType: 'Batch',
            aggregateId: batchId,
            dedupeKey: `batch.rejected:${batchId}:v${batch.version}:${stage}`,
            payload: basePayload,
          });
        } else if (stage === 'DISTRICT') {
          await enqueueEvent(tx, {
            type: EVENTS.batchDistrictApproved,
            aggregateType: 'Batch',
            aggregateId: batchId,
            dedupeKey: `batch.district.approved:${batchId}:v${batch.version}`,
            payload: basePayload,
          });
        } else if (stage === 'QUALITY') {
          await enqueueEvent(tx, {
            type: EVENTS.batchQualityApproved,
            aggregateType: 'Batch',
            aggregateId: batchId,
            dedupeKey: `batch.quality.approved:${batchId}:v${batch.version}`,
            payload: basePayload,
          });
        } else if (stage === 'STATE') {
          await enqueueEvent(tx, {
            type: EVENTS.batchStateApproved,
            aggregateType: 'Batch',
            aggregateId: batchId,
            dedupeKey: `batch.state.approved:${batchId}:v${batch.version}`,
            payload: basePayload,
          });
          await enqueueEvent(tx, {
            type: EVENTS.certificateGenerateRequested,
            aggregateType: 'Batch',
            aggregateId: batchId,
            dedupeKey: `cert.gen.req:${batchId}:v${batch.version}`,
            payload: { batchId, code: batch.code, version: batch.version, districtId: batch.districtId, trainingCenterId: batch.trainingCenterId },
          });
        }
      }

      return { batch: updated, approval, progressed, nextStatus };
    }, TX_OPTS);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`You have already submitted a ${stage.toLowerCase()} decision for this batch version`);
    }
    throw err;
  }
}
