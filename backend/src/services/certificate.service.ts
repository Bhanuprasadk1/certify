import { createHash } from 'node:crypto';
import { prisma, lockBatch, lockCertificate, TX_OPTS } from '../lib/prisma.js';
import { badRequest, conflict, forbidden, gone, notFound } from '../lib/errors.js';
import { EVENTS } from '../bus/types.js';
import { audit } from './audit.service.js';
import { enqueueEvent, enqueueEvents } from './outbox.service.js';
import { generateCertificatePdf, readCertificatePdf, verificationUrlFor } from './pdf.service.js';
import { getConfig } from './config.service.js';
import type { AuthUser } from './auth.service.js';
import { certificateScope } from './scope.service.js';

/** Deterministic certificate number derived from batch code + candidate id so replays stay idempotent. */
function deterministicCertNumber(batchCode: string, candidateId: string, rowNumber: number): string {
  const year = new Date().getUTCFullYear();
  const suffix = createHash('sha256').update(`${batchCode}:${candidateId}`).digest('hex').slice(0, 6).toUpperCase();
  const seq = String(rowNumber).padStart(4, '0');
  return `PSM-${year}-${seq}-${suffix}`;
}

function deterministicVerifyToken(batchId: string, candidateId: string): string {
  return createHash('sha256').update(`verify:${batchId}:${candidateId}`).digest('base64url').slice(0, 28);
}

/**
 * Idempotent, set-oriented asynchronous certificate generation for an APPROVED / CERTIFICATE_PROCESSING batch.
 * Safe to invoke multiple times or on replayed queue events:
 * - Bulk-creates missing Certificate rows using @@unique([batchId, candidateId]) + skipDuplicates.
 * - Renders missing PDFs in bounded parallel chunks (never overwrites cancelled certificates).
 * - Bulk-creates missing DeliveryJobs using @unique(certificateId, idempotencyKey) + skipDuplicates.
 */
export async function generateCertificatesForBatch(batchId: string): Promise<{
  total: number;
  created: number;
  reused: number;
  deliveryJobsCreated: number;
}> {
  const retryCfg = await getConfig('delivery.retry');

  const batch = await prisma.$transaction(async (tx) => {
    const locked = await lockBatch(tx, batchId);
    if (!locked) return null;
    const b = await tx.batch.findUniqueOrThrow({
      where: { id: batchId },
      include: { district: true, trainingCenter: true, candidates: { orderBy: { rowNumber: 'asc' } } },
    });
    if (b.status === 'APPROVED') {
      await tx.batch.update({ where: { id: batchId }, data: { status: 'CERTIFICATE_PROCESSING', stageEnteredAt: new Date() } });
    } else if (b.status !== 'CERTIFICATE_PROCESSING' && b.status !== 'CERTIFICATES_ISSUED') {
      return null;
    }
    return b;
  }, TX_OPTS);

  if (!batch) {
    return { total: 0, created: 0, reused: 0, deliveryJobsCreated: 0 };
  }

  const total = batch.candidates.length;
  const now = new Date();

  // 1. Bulk-insert missing Certificate rows (idempotent via unique constraints)
  const insertedCerts = await prisma.certificate.createMany({
    data: batch.candidates.map((cand) => ({
      certificateNumber: deterministicCertNumber(batch.code, cand.id, cand.rowNumber),
      verificationToken: deterministicVerifyToken(batch.id, cand.id),
      batchId: batch.id,
      candidateId: cand.id,
      candidateName: cand.name,
      courseName: cand.courseName,
      trainingCenterName: batch.trainingCenter.name,
      completionDate: cand.completionDate,
      status: 'PENDING',
    })),
    skipDuplicates: true,
  });

  const created = insertedCerts.count;
  const reused = total - created;

  // 2. Load all certificates for the batch in a single query
  const certs = await prisma.certificate.findMany({
    where: { batchId: batch.id },
    orderBy: { certificateNumber: 'asc' },
  });

  // 3. Render PDFs in bounded parallel chunks of 8 for any non-cancelled cert missing its PDF or still PENDING
  const toIssue: { id: string; pdfPath: string; issueDate: Date; certificateNumber: string }[] = [];
  const activeCerts = certs.filter((c) => c.status !== 'CANCELLED');

  const CHUNK = 8;
  for (let i = 0; i < activeCerts.length; i += CHUNK) {
    const slice = activeCerts.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (cert) => {
        const existingPdf = cert.pdfPath ? await readCertificatePdf(cert.pdfPath) : null;
        if (cert.status !== 'ISSUED' || !existingPdf) {
          const issueDate = cert.issuedAt ?? now;
          const pdfFilename = await generateCertificatePdf({
            certificateNumber: cert.certificateNumber,
            verificationToken: cert.verificationToken,
            candidateName: cert.candidateName,
            courseName: cert.courseName,
            trainingCenterName: cert.trainingCenterName,
            districtName: batch.district.name,
            completionDate: cert.completionDate,
            issueDate,
            status: 'ISSUED',
          });
          toIssue.push({ id: cert.id, pdfPath: pdfFilename, issueDate, certificateNumber: cert.certificateNumber });
        }
      }),
    );
  }

  // 4. Bulk-update issued certificates, bulk-create missing DeliveryJobs, and enqueue outbox events in one transaction
  const deliveryJobsCreated = await prisma.$transaction(async (tx) => {
    if (toIssue.length > 0) {
      await Promise.all(
        toIssue.map((u) =>
          tx.certificate.update({
            where: { id: u.id },
            data: { status: 'ISSUED', pdfPath: u.pdfPath, issuedAt: u.issueDate },
          }),
        ),
      );
    }

    const insertedJobs = await tx.deliveryJob.createMany({
      data: activeCerts.map((cert) => ({
        certificateId: cert.id,
        idempotencyKey: `wa:${cert.id}`,
        channel: 'WHATSAPP',
        status: 'PENDING',
        maxAttempts: retryCfg.maxAttempts,
      })),
      skipDuplicates: true,
    });

    if (insertedJobs.count > 0) {
      const jobs = await tx.deliveryJob.findMany({
        where: { certificateId: { in: activeCerts.map((c) => c.id) } },
        select: { id: true, certificateId: true },
      });
      await enqueueEvents(
        tx,
        jobs.map((job) => ({
          type: EVENTS.whatsappDeliveryRequested,
          aggregateType: 'DeliveryJob',
          aggregateId: job.id,
          dedupeKey: `wa.req:${job.id}`,
          payload: {
            jobId: job.id,
            certificateId: job.certificateId,
            batchId: batch.id,
            districtId: batch.districtId,
            trainingCenterId: batch.trainingCenterId,
          },
        })),
      );
    }

    await lockBatch(tx, batch.id);
    const current = await tx.batch.findUniqueOrThrow({ where: { id: batch.id } });
    if (current.status === 'CERTIFICATE_PROCESSING' || current.status === 'APPROVED') {
      const issuedCount = await tx.certificate.count({
        where: { batchId: batch.id, status: { in: ['ISSUED', 'CANCELLED'] } },
      });
      if (issuedCount >= total) {
        await tx.batch.update({
          where: { id: batch.id },
          data: { status: 'CERTIFICATES_ISSUED', issuedAt: new Date(), stageEnteredAt: new Date() },
        });
        await audit(
          {
            action: 'batch.certificates.issued',
            resourceType: 'Batch',
            resourceId: batch.id,
            batchId: batch.id,
            metadata: { total, issuedCount },
          },
          tx,
        );
        await enqueueEvent(tx, {
          type: EVENTS.certificateProgress,
          aggregateType: 'Batch',
          aggregateId: batch.id,
          dedupeKey: `cert.batch.done:${batch.id}:v${current.version}`,
          payload: {
            batchId: batch.id,
            code: batch.code,
            status: 'CERTIFICATES_ISSUED',
            districtId: batch.districtId,
            trainingCenterId: batch.trainingCenterId,
            done: issuedCount,
            total,
          },
        });
      }
    }

    return insertedJobs.count;
  }, TX_OPTS);

  return { total, created, reused, deliveryJobsCreated };
}

/** State-officer-only transactional certificate cancellation. */
export async function cancelCertificate(user: AuthUser, certificateId: string, reason: string, ip: string) {
  if (user.role !== 'STATE_OFFICER') {
    throw forbidden('Only authorized State Officers can cancel certificates');
  }
  if (!reason || reason.trim().length < 5) {
    throw badRequest('A cancellation reason of at least 5 characters is mandatory');
  }

  return prisma.$transaction(async (tx) => {
    const locked = await lockCertificate(tx, certificateId);
    if (!locked) throw notFound('Certificate not found');

    const cert = await tx.certificate.findUniqueOrThrow({
      where: { id: certificateId },
      include: { batch: true, deliveryJob: true },
    });
    if (cert.status === 'CANCELLED') {
      throw conflict('Certificate is already cancelled');
    }
    if (cert.status !== 'ISSUED') {
      throw conflict(`Cannot cancel certificate in status ${cert.status}`);
    }

    const previousStatus = cert.status;
    const now = new Date();
    const updated = await tx.certificate.update({
      where: { id: certificateId },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledById: user.id,
        cancelReason: reason.trim(),
      },
    });

    await tx.deliveryJob.updateMany({
      where: { certificateId, status: { in: ['PENDING', 'RETRYING', 'PROCESSING'] } },
      data: { status: 'CANCELLED', lastError: 'Certificate cancelled before delivery' },
    });

    await audit(
      {
        actor: user,
        action: 'certificate.cancelled',
        resourceType: 'Certificate',
        resourceId: certificateId,
        batchId: cert.batchId,
        reason: reason.trim(),
        metadata: {
          certificateNumber: cert.certificateNumber,
          previousStatus,
          newStatus: 'CANCELLED',
        },
        ip,
      },
      tx,
    );

    await enqueueEvent(tx, {
      type: EVENTS.certificateCancelled,
      aggregateType: 'Certificate',
      aggregateId: certificateId,
      dedupeKey: `cert.cancelled:${certificateId}`,
      payload: {
        certificateId,
        certificateNumber: cert.certificateNumber,
        batchId: cert.batchId,
        districtId: cert.batch.districtId,
        trainingCenterId: cert.batch.trainingCenterId,
        reason: reason.trim(),
      },
    });

    return updated;
  }, TX_OPTS);
}

/**
 * Authoritative public verification lookup.
 * Always reads PostgreSQL directly (never stale Redis cache) so cancellation takes effect immediately.
 * Exposes ONLY minimal non-sensitive fields (never phone, email, address, or internal IDs).
 */
export async function publicVerifyCertificate(tokenOrNumber: string) {
  const key = tokenOrNumber.trim();
  const verifiedAt = new Date().toISOString();
  if (!key || key.length > 100) {
    return { status: 'INVALID' as const, verifiedAt };
  }

  const cert = await prisma.certificate.findFirst({
    where: {
      OR: [{ verificationToken: key }, { certificateNumber: { equals: key, mode: 'insensitive' } }],
    },
    include: { batch: { include: { district: true } } },
  });

  if (!cert) {
    return { status: 'INVALID' as const, verifiedAt };
  }

  if (cert.status === 'PENDING' || cert.status === 'FAILED') {
    return {
      status: 'NOT_ISSUED' as const,
      certificateNumber: cert.certificateNumber,
      verifiedAt,
    };
  }

  if (cert.status === 'CANCELLED') {
    return {
      status: 'CANCELLED' as const,
      certificateNumber: cert.certificateNumber,
      candidateName: cert.candidateName,
      courseName: cert.courseName,
      trainingCenter: cert.trainingCenterName,
      district: cert.batch.district.name,
      issueDate: cert.issuedAt,
      cancelledAt: cert.cancelledAt,
      verifiedAt,
    };
  }

  return {
    status: 'VALID' as const,
    certificateNumber: cert.certificateNumber,
    candidateName: cert.candidateName,
    courseName: cert.courseName,
    trainingCenter: cert.trainingCenterName,
    district: cert.batch.district.name,
    completionDate: cert.completionDate,
    issueDate: cert.issuedAt,
    verificationUrl: verificationUrlFor(cert.verificationToken),
    verifiedAt,
  };
}

/** Authorize and read a certificate PDF; blocks download if cancelled. */
export async function getAuthorizedCertificatePdf(user: AuthUser, certificateId: string) {
  const cert = await prisma.certificate.findFirst({
    where: { id: certificateId, ...certificateScope(user) },
    include: { batch: { include: { district: true } } },
  });
  if (!cert) throw notFound('Certificate not found');
  if (cert.status === 'CANCELLED') {
    throw gone('Certificate has been cancelled and cannot be downloaded');
  }
  if (cert.status !== 'ISSUED') {
    throw conflict('Certificate PDF has not been generated yet');
  }

  let buf = cert.pdfPath ? await readCertificatePdf(cert.pdfPath) : null;
  if (!buf) {
    const filename = await generateCertificatePdf({
      certificateNumber: cert.certificateNumber,
      verificationToken: cert.verificationToken,
      candidateName: cert.candidateName,
      courseName: cert.courseName,
      trainingCenterName: cert.trainingCenterName,
      districtName: cert.batch.district.name,
      completionDate: cert.completionDate,
      issueDate: cert.issuedAt ?? new Date(),
      status: cert.status,
    });
    await prisma.certificate.update({ where: { id: cert.id }, data: { pdfPath: filename } });
    buf = await readCertificatePdf(filename);
  }
  if (!buf) throw notFound('Certificate PDF file unavailable');
  return { cert, buffer: buf };
}
