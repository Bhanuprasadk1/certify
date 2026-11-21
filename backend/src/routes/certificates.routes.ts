import { Router } from 'express';
import { z } from 'zod';
import { CertificateStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { notFound, parse } from '../lib/errors.js';
import { asyncHandler, clientIp, ok, pageMeta, paginationSchema, uuidParam } from '../lib/http.js';
import { safeFilename } from '../lib/crypto.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { verifyLimiter } from '../middleware/rateLimit.middleware.js';
import { certificateScope } from '../services/scope.service.js';
import {
  cancelCertificate,
  getAuthorizedCertificatePdf,
  publicVerifyCertificate,
} from '../services/certificate.service.js';
import { verificationUrlFor } from '../services/pdf.service.js';
import { audit } from '../services/audit.service.js';

export const certificatesRouter = Router();

const listQuerySchema = paginationSchema.extend({
  search: z.string().max(100).optional(),
  status: z.nativeEnum(CertificateStatus).optional(),
  batchId: z.string().uuid().optional(),
});

const cancelSchema = z.object({
  reason: z.string().min(5, 'Cancellation reason must be at least 5 characters').max(1000),
});

certificatesRouter.get(
  '/certificates',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = parse(listQuerySchema, req.query);
    const where: Prisma.CertificateWhereInput = {
      AND: [
        certificateScope(req.user!),
        ...(q.status ? [{ status: q.status }] : []),
        ...(q.batchId ? [{ batchId: q.batchId }] : []),
        ...(q.search
          ? [
              {
                OR: [
                  { certificateNumber: { contains: q.search, mode: 'insensitive' as const } },
                  { candidateName: { contains: q.search, mode: 'insensitive' as const } },
                  { courseName: { contains: q.search, mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    };

    const [total, items] = await Promise.all([
      prisma.certificate.count({ where }),
      prisma.certificate.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          batch: { select: { id: true, code: true, title: true, district: { select: { name: true } } } },
          deliveryJob: { select: { id: true, status: true, attempts: true, sentAt: true, lastError: true } },
        },
      }),
    ]);

    ok(
      res,
      items.map((c) => ({ ...c, verificationUrl: verificationUrlFor(c.verificationToken) })),
      pageMeta(q.page, q.pageSize, total),
    );
  }),
);

certificatesRouter.get(
  '/certificates/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const cert = await prisma.certificate.findFirst({
      where: { id, ...certificateScope(req.user!) },
      include: {
        batch: { include: { district: true, trainingCenter: true } },
        cancelledBy: { select: { id: true, name: true, email: true } },
        deliveryJob: { include: { attemptLogs: { orderBy: { attemptNo: 'desc' } } } },
      },
    });
    if (!cert) throw notFound('Certificate not found');
    ok(res, { ...cert, verificationUrl: verificationUrlFor(cert.verificationToken) });
  }),
);

certificatesRouter.get(
  '/certificates/:id/download',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { cert, buffer } = await getAuthorizedCertificatePdf(req.user!, id);
    await audit({
      actor: req.user!,
      action: 'certificate.downloaded',
      resourceType: 'Certificate',
      resourceId: cert.id,
      batchId: cert.batchId,
      ip: clientIp(req),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(cert.certificateNumber)}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }),
);

certificatesRouter.post(
  '/certificates/:id/cancel',
  requireAuth,
  requireRole('STATE_OFFICER'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(cancelSchema, req.body);
    const cancelled = await cancelCertificate(req.user!, id, body.reason, clientIp(req));
    ok(res, cancelled);
  }),
);

// Public authoritative verification endpoint (no auth required, rate-limited, minimal non-PII response)
certificatesRouter.get(
  '/public/verify/:token',
  verifyLimiter,
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await publicVerifyCertificate(String(req.params.token ?? '')));
  }),
);
