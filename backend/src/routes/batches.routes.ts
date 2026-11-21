import { Router } from 'express';
import { z } from 'zod';
import { BatchStatus, Decision, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { badRequest, notFound, parse, unprocessable } from '../lib/errors.js';
import { asyncHandler, clientIp, ok, pageMeta, paginationSchema, uuidParam } from '../lib/http.js';
import { maskEmail, maskPhone } from '../lib/crypto.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { candidateUpload } from '../middleware/upload.middleware.js';
import { batchScope, canSeeCandidateContact } from '../services/scope.service.js';
import { parseCandidateFile } from '../services/csv.service.js';
import {
  createBatch,
  recordReviewDecision,
  replaceBatchCandidates,
  resubmitBatch,
  submitBatch,
  updateBatch,
} from '../services/workflow.service.js';
import { getConfig } from '../services/config.service.js';

export const batchesRouter = Router();

const dateStr = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date')
  .transform((v) => new Date(v));

const createBatchSchema = z.object({
  title: z.string().min(3).max(160),
  courseName: z.string().min(2).max(160),
  courseCode: z.string().min(2).max(32),
  startDate: dateStr.optional().nullable(),
  completionDate: dateStr,
});

const updateBatchSchema = createBatchSchema.partial();

const decisionSchema = z.object({
  decision: z.nativeEnum(Decision),
  reason: z.string().max(1000).optional(),
});

const listQuerySchema = paginationSchema.extend({
  search: z.string().max(100).optional(),
  status: z.nativeEnum(BatchStatus).optional(),
  districtId: z.string().uuid().optional(),
});

batchesRouter.post(
  '/batches',
  requireAuth,
  requireRole('TRAINING_CENTER'),
  asyncHandler(async (req, res) => {
    const body = parse(createBatchSchema, req.body);
    const batch = await createBatch(req.user!, body, clientIp(req));
    ok(res, batch, undefined, 201);
  }),
);

batchesRouter.get(
  '/batches',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = parse(listQuerySchema, req.query);
    const scope = batchScope(req.user!);
    const where: Prisma.BatchWhereInput = {
      AND: [
        scope,
        ...(q.status ? [{ status: q.status }] : []),
        ...(q.districtId ? [{ districtId: q.districtId }] : []),
        ...(q.search
          ? [
              {
                OR: [
                  { code: { contains: q.search, mode: 'insensitive' as const } },
                  { title: { contains: q.search, mode: 'insensitive' as const } },
                  { courseName: { contains: q.search, mode: 'insensitive' as const } },
                  { trainingCenter: { name: { contains: q.search, mode: 'insensitive' as const } } },
                ],
              },
            ]
          : []),
      ],
    };

    const [total, items] = await Promise.all([
      prisma.batch.count({ where }),
      prisma.batch.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          district: { select: { id: true, name: true, code: true } },
          trainingCenter: { select: { id: true, name: true, code: true } },
          _count: { select: { candidates: true, certificates: true } },
          approvals: {
            select: { id: true, version: true, stage: true, decision: true, reviewerId: true, createdAt: true },
          },
        },
      }),
    ]);

    ok(res, items, pageMeta(q.page, q.pageSize, total));
  }),
);

batchesRouter.get(
  '/batches/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const batch = await prisma.batch.findFirst({
      where: { id, ...batchScope(req.user!) },
      include: {
        district: true,
        trainingCenter: true,
        createdBy: { select: { id: true, name: true, email: true } },
        candidates: {
          orderBy: { rowNumber: 'asc' },
          include: {
            certificate: {
              select: {
                id: true,
                certificateNumber: true,
                status: true,
                issuedAt: true,
                deliveryJob: { select: { id: true, status: true, attempts: true } },
              },
            },
          },
        },
        approvals: {
          orderBy: { createdAt: 'asc' },
          include: { reviewer: { select: { id: true, name: true, email: true, role: true } } },
        },
        escalations: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!batch) throw notFound('Batch not found');

    const auditLogs = await prisma.auditLog.findMany({
      where: { batchId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { actor: { select: { id: true, name: true, role: true } } },
    });

    const fullContact = canSeeCandidateContact(req.user!, batch);
    const candidates = batch.candidates.map((c) => ({
      ...c,
      phone: fullContact ? c.phone : maskPhone(c.phone),
      email: fullContact ? c.email : maskEmail(c.email),
    }));

    const requiredDistrictApprovals = await getConfig('district.requiredApprovals');
    const currentDistrictApprovals = batch.approvals.filter(
      (a) => a.version === batch.version && a.stage === 'DISTRICT' && a.decision === 'APPROVE',
    ).length;

    ok(res, {
      ...batch,
      candidates,
      auditLogs,
      workflowMeta: {
        requiredDistrictApprovals,
        currentDistrictApprovals,
        alreadyReviewedByMe: batch.approvals.some(
          (a) =>
            a.version === batch.version &&
            a.reviewerId === req.user!.id &&
            ((batch.status === 'DISTRICT_REVIEW' && a.stage === 'DISTRICT') ||
              (batch.status === 'QUALITY_REVIEW' && a.stage === 'QUALITY') ||
              (batch.status === 'STATE_REVIEW' && a.stage === 'STATE')),
        ),
      },
    });
  }),
);

batchesRouter.put(
  '/batches/:id',
  requireAuth,
  requireRole('TRAINING_CENTER'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateBatchSchema, req.body);
    const updated = await updateBatch(req.user!, id, body, clientIp(req));
    ok(res, updated);
  }),
);

batchesRouter.post(
  '/batches/:id/upload',
  requireAuth,
  requireRole('TRAINING_CENTER'),
  candidateUpload.single('file'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    if (!req.file) throw badRequest('Candidate CSV or XLSX file is required (field name: "file")');
    const previewOnly = String(req.query.preview ?? '').toLowerCase() === 'true';

    // Ownership & status check before parsing
    const batch = await prisma.batch.findFirst({ where: { id, ...batchScope(req.user!) } });
    if (!batch) throw notFound('Batch not found');

    const result = await parseCandidateFile(req.file.buffer, req.file.originalname, {
      courseName: batch.courseName,
      completionDate: batch.completionDate,
    });

    if (!result.valid) {
      // Atomic guarantee: NEVER save partial rows when any row fails validation.
      throw unprocessable('Candidate validation failed', result.errors);
    }

    if (previewOnly) {
      const threshold = await getConfig('quality.threshold');
      return ok(res, {
        preview: true,
        valid: true,
        totalRows: result.totalRows,
        requiresQuality: result.totalRows >= threshold,
        candidates: result.candidates.slice(0, 100),
      });
    }

    const updated = await replaceBatchCandidates(req.user!, id, result.candidates, clientIp(req));
    ok(res, {
      preview: false,
      valid: true,
      uploadedCount: result.candidates.length,
      requiresQuality: updated.requiresQuality,
      batch: updated,
    });
  }),
);

batchesRouter.post(
  '/batches/:id/submit',
  requireAuth,
  requireRole('TRAINING_CENTER'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    ok(res, await submitBatch(req.user!, id, clientIp(req)));
  }),
);

batchesRouter.post(
  '/batches/:id/resubmit',
  requireAuth,
  requireRole('TRAINING_CENTER'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    ok(res, await resubmitBatch(req.user!, id, clientIp(req)));
  }),
);

// Stage-specific review queues
batchesRouter.get(
  '/district/batches/pending',
  requireAuth,
  requireRole('DISTRICT_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const where: Prisma.BatchWhereInput = {
      status: 'DISTRICT_REVIEW',
      ...(req.user!.role === 'DISTRICT_OFFICER' ? { districtId: req.user!.districtId ?? '__none__' } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.batch.count({ where }),
      prisma.batch.findMany({
        where,
        orderBy: { stageEnteredAt: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          district: true,
          trainingCenter: true,
          approvals: { include: { reviewer: { select: { id: true, name: true } } } },
        },
      }),
    ]);
    ok(res, items, pageMeta(q.page, q.pageSize, total));
  }),
);

batchesRouter.post(
  '/batches/:id/district-decision',
  requireAuth,
  requireRole('DISTRICT_OFFICER'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(decisionSchema, req.body);
    ok(res, await recordReviewDecision(req.user!, id, 'DISTRICT', body.decision, body.reason, clientIp(req)));
  }),
);

batchesRouter.get(
  '/quality/batches/pending',
  requireAuth,
  requireRole('QUALITY_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const where: Prisma.BatchWhereInput = { status: 'QUALITY_REVIEW' };
    const [total, items] = await Promise.all([
      prisma.batch.count({ where }),
      prisma.batch.findMany({
        where,
        orderBy: { stageEnteredAt: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          district: true,
          trainingCenter: true,
          approvals: { include: { reviewer: { select: { id: true, name: true } } } },
        },
      }),
    ]);
    ok(res, items, pageMeta(q.page, q.pageSize, total));
  }),
);

batchesRouter.post(
  '/batches/:id/quality-decision',
  requireAuth,
  requireRole('QUALITY_OFFICER'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(decisionSchema, req.body);
    ok(res, await recordReviewDecision(req.user!, id, 'QUALITY', body.decision, body.reason, clientIp(req)));
  }),
);

batchesRouter.get(
  '/state/batches/pending',
  requireAuth,
  requireRole('STATE_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const where: Prisma.BatchWhereInput = { status: 'STATE_REVIEW' };
    const [total, items] = await Promise.all([
      prisma.batch.count({ where }),
      prisma.batch.findMany({
        where,
        orderBy: { stageEnteredAt: 'asc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          district: true,
          trainingCenter: true,
          approvals: { include: { reviewer: { select: { id: true, name: true, role: true } } } },
        },
      }),
    ]);
    ok(res, items, pageMeta(q.page, q.pageSize, total));
  }),
);

batchesRouter.post(
  '/batches/:id/state-decision',
  requireAuth,
  requireRole('STATE_OFFICER'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(decisionSchema, req.body);
    ok(res, await recordReviewDecision(req.user!, id, 'STATE', body.decision, body.reason, clientIp(req)));
  }),
);

batchesRouter.get(
  '/state/batches/stuck',
  requireAuth,
  requireRole('STATE_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (_req, res) => {
    const escalations = await prisma.batchEscalation.findMany({
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        batch: { include: { district: true, trainingCenter: true } },
        resolvedBy: { select: { id: true, name: true } },
      },
    });
    ok(res, escalations);
  }),
);
