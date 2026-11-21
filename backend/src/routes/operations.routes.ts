import { Router } from 'express';
import { z } from 'zod';
import { DeliveryStatus, Prisma, RoleCode } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { conflict, notFound, parse } from '../lib/errors.js';
import { asyncHandler, clientIp, ok, pageMeta, paginationSchema, uuidParam } from '../lib/http.js';
import { maskPhone } from '../lib/crypto.js';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { batchScope, certificateScope, deliveryScope } from '../services/scope.service.js';
import { manualRetryDeliveryJob } from '../services/delivery.service.js';
import { scanStuckBatches, simulateStuckBatch, updateEscalationStatus } from '../services/escalation.service.js';
import { listConfig, setConfig } from '../services/config.service.js';
import { audit } from '../services/audit.service.js';
import { hashPassword } from '../services/auth.service.js';
import { redisPing } from '../lib/redis.js';
import { currentBus } from '../bus/index.js';
import { env } from '../config/env.js';

export const operationsRouter = Router();

// --- Public / Ops Health ---
operationsRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    let db: 'up' | 'down' = 'up';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    const redis = await redisPing();
    const bus = currentBus();
    const broker = bus ? (bus.isConnected() ? 'up' : 'down') : 'down';
    const healthy = db === 'up';
    res.status(healthy ? 200 : 503).json({
      success: healthy,
      data: {
        status: healthy ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        dependencies: {
          database: db,
          redis,
          broker: { driver: bus?.driver ?? env.QUEUE_DRIVER, status: broker },
        },
      },
    });
  }),
);

// --- Dashboard Summary (Role-scoped) ---
operationsRouter.get(
  '/dashboard/summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const bWhere = batchScope(req.user!);
    const cWhere = certificateScope(req.user!);
    const dWhere = deliveryScope(req.user!);

    const [
      batchStatusGroups,
      candidateSum,
      certStatusGroups,
      deliveryStatusGroups,
      openEscalations,
      recentBatches,
      districtBreakdown,
    ] = await Promise.all([
      prisma.batch.groupBy({ by: ['status'], where: bWhere, _count: { _all: true } }),
      prisma.batch.aggregate({ where: bWhere, _sum: { candidateCount: true } }),
      prisma.certificate.groupBy({ by: ['status'], where: cWhere, _count: { _all: true } }),
      prisma.deliveryJob.groupBy({ by: ['status'], where: dWhere, _count: { _all: true } }),
      prisma.batchEscalation.count({
        where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, batch: bWhere },
      }),
      prisma.batch.findMany({
        where: bWhere,
        orderBy: { updatedAt: 'desc' },
        take: 6,
        include: {
          district: { select: { name: true } },
          trainingCenter: { select: { name: true } },
        },
      }),
      prisma.batch.groupBy({ by: ['districtId'], where: bWhere, _count: { _all: true }, _sum: { candidateCount: true } }),
    ]);

    const districts = await prisma.district.findMany({ select: { id: true, name: true } });
    const distMap = new Map(districts.map((d) => [d.id, d.name]));

    const bMap = Object.fromEntries(batchStatusGroups.map((g) => [g.status, g._count._all])) as Record<string, number>;
    const cMap = Object.fromEntries(certStatusGroups.map((g) => [g.status, g._count._all])) as Record<string, number>;
    const dMap = Object.fromEntries(deliveryStatusGroups.map((g) => [g.status, g._count._all])) as Record<string, number>;

    const totalBatches = Object.values(bMap).reduce((a, b) => a + b, 0);
    const pendingBatches = (bMap.SUBMITTED ?? 0) + (bMap.DISTRICT_REVIEW ?? 0) + (bMap.QUALITY_REVIEW ?? 0) + (bMap.STATE_REVIEW ?? 0);
    const approvedBatches = (bMap.APPROVED ?? 0) + (bMap.CERTIFICATE_PROCESSING ?? 0) + (bMap.CERTIFICATES_ISSUED ?? 0);

    ok(res, {
      metrics: {
        totalBatches,
        draftBatches: bMap.DRAFT ?? 0,
        pendingBatches,
        districtReview: bMap.DISTRICT_REVIEW ?? 0,
        qualityReview: bMap.QUALITY_REVIEW ?? 0,
        stateReview: bMap.STATE_REVIEW ?? 0,
        approvedBatches,
        returnedBatches: bMap.RETURNED ?? 0,
        rejectedBatches: bMap.REJECTED ?? 0,
        totalCandidates: candidateSum._sum.candidateCount ?? 0,
        certificatesIssued: cMap.ISSUED ?? 0,
        certificatesCancelled: cMap.CANCELLED ?? 0,
        certificatesPending: cMap.PENDING ?? 0,
        deliveriesSent: dMap.SENT ?? 0,
        deliveriesRetrying: dMap.RETRYING ?? 0,
        deliveriesFailed: dMap.FAILED ?? 0,
        deliveriesPending: (dMap.PENDING ?? 0) + (dMap.PROCESSING ?? 0),
        openEscalations,
      },
      charts: {
        batchesByStatus: Object.entries(bMap).map(([status, count]) => ({ status, count })),
        deliveryByStatus: Object.entries(dMap).map(([status, count]) => ({ status, count })),
        batchesByDistrict: districtBreakdown.map((d) => ({
          district: distMap.get(d.districtId) ?? 'Unknown',
          batches: d._count._all,
          candidates: d._sum.candidateCount ?? 0,
        })),
      },
      recentBatches,
    });
  }),
);

// --- Delivery Monitoring ---
const deliveryQuerySchema = paginationSchema.extend({
  status: z.nativeEnum(DeliveryStatus).optional(),
  batchId: z.string().uuid().optional(),
  search: z.string().max(100).optional(),
});

operationsRouter.get(
  '/delivery/jobs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const q = parse(deliveryQuerySchema, req.query);
    const where: Prisma.DeliveryJobWhereInput = {
      AND: [
        deliveryScope(req.user!),
        ...(q.status ? [{ status: q.status }] : []),
        ...(q.batchId ? [{ certificate: { batchId: q.batchId } }] : []),
        ...(q.search
          ? [
              {
                certificate: {
                  OR: [
                    { candidateName: { contains: q.search, mode: 'insensitive' as const } },
                    { certificateNumber: { contains: q.search, mode: 'insensitive' as const } },
                  ],
                },
              },
            ]
          : []),
      ],
    };

    const [total, items] = await Promise.all([
      prisma.deliveryJob.count({ where }),
      prisma.deliveryJob.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          certificate: {
            select: {
              id: true,
              certificateNumber: true,
              candidateName: true,
              courseName: true,
              status: true,
              batch: { select: { id: true, code: true } },
              candidate: { select: { phone: true } },
            },
          },
          attemptLogs: { orderBy: { attemptNo: 'desc' }, take: 5 },
        },
      }),
    ]);

    ok(
      res,
      items.map((j) => ({
        ...j,
        recipientMasked: maskPhone(j.certificate.candidate.phone),
        certificate: {
          id: j.certificate.id,
          certificateNumber: j.certificate.certificateNumber,
          candidateName: j.certificate.candidateName,
          courseName: j.certificate.courseName,
          status: j.certificate.status,
          batch: j.certificate.batch,
        },
      })),
      pageMeta(q.page, q.pageSize, total),
    );
  }),
);

operationsRouter.get(
  '/delivery/jobs/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const job = await prisma.deliveryJob.findFirst({
      where: { id, ...deliveryScope(req.user!) },
      include: {
        certificate: { include: { batch: { select: { id: true, code: true, title: true } }, candidate: { select: { phone: true } } } },
        attemptLogs: { orderBy: { attemptNo: 'asc' } },
      },
    });
    if (!job) throw notFound('Delivery job not found');
    ok(res, { ...job, recipientMasked: maskPhone(job.certificate.candidate.phone) });
  }),
);

operationsRouter.post(
  '/delivery/jobs/:id/retry',
  requireAuth,
  requireRole('STATE_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    ok(res, await manualRetryDeliveryJob(req.user!, id, clientIp(req)));
  }),
);

// --- Escalations ---
operationsRouter.get(
  '/escalations',
  requireAuth,
  requireRole('STATE_OFFICER', 'SUPER_ADMIN', 'DISTRICT_OFFICER', 'QUALITY_OFFICER'),
  asyncHandler(async (req, res) => {
    const where: Prisma.BatchEscalationWhereInput = { batch: batchScope(req.user!) };
    const items = await prisma.batchEscalation.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        batch: { select: { id: true, code: true, title: true, status: true, stageEnteredAt: true, district: { select: { name: true } }, trainingCenter: { select: { name: true } } } },
        resolvedBy: { select: { id: true, name: true } },
      },
    });
    ok(res, items);
  }),
);

operationsRouter.post(
  '/escalations/scan',
  requireAuth,
  requireRole('STATE_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (_req, res) => {
    ok(res, await scanStuckBatches());
  }),
);

operationsRouter.post(
  '/escalations/simulate/:id',
  requireAuth,
  requireRole('STATE_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    ok(res, await simulateStuckBatch(req.user!, id, clientIp(req)));
  }),
);

const updateEscalationSchema = z.object({
  status: z.enum(['ACKNOWLEDGED', 'RESOLVED']),
  resolution: z.string().max(1000).optional(),
});

operationsRouter.patch(
  '/escalations/:id',
  requireAuth,
  requireRole('STATE_OFFICER', 'SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(updateEscalationSchema, req.body);
    ok(res, await updateEscalationStatus(req.user!, id, body.status, body.resolution, clientIp(req)));
  }),
);

// --- Audit Logs ---
const auditQuerySchema = paginationSchema.extend({
  action: z.string().max(80).optional(),
  resourceType: z.string().max(60).optional(),
  batchId: z.string().uuid().optional(),
  search: z.string().max(100).optional(),
});

operationsRouter.get(
  '/audit-logs',
  requireAuth,
  requireRole('SUPER_ADMIN', 'STATE_OFFICER'),
  asyncHandler(async (req, res) => {
    const q = parse(auditQuerySchema, req.query);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
      ...(q.resourceType ? { resourceType: q.resourceType } : {}),
      ...(q.batchId ? { batchId: q.batchId } : {}),
      ...(q.search
        ? {
            OR: [
              { action: { contains: q.search, mode: 'insensitive' } },
              { reason: { contains: q.search, mode: 'insensitive' } },
              { actor: { name: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actor: { select: { id: true, name: true, email: true, role: true } } },
      }),
    ]);
    ok(res, items, pageMeta(q.page, q.pageSize, total));
  }),
);

// --- Admin Settings, Users, System Health, Demo Reset ---
operationsRouter.get(
  '/admin/config',
  requireAuth,
  requireRole('SUPER_ADMIN', 'STATE_OFFICER'),
  asyncHandler(async (_req, res) => {
    ok(res, await listConfig());
  }),
);

operationsRouter.put(
  '/admin/config/:key',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const updated = await setConfig(key, req.body?.value, req.user!.id);
    await audit({
      actor: req.user!,
      action: 'config.updated',
      resourceType: 'SystemConfiguration',
      resourceId: key,
      metadata: { key },
      ip: clientIp(req),
    });
    ok(res, updated);
  }),
);

operationsRouter.get(
  '/admin/users',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (_req, res) => {
    const [users, districts, centers] = await Promise.all([
      prisma.user.findMany({
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
          district: { select: { id: true, name: true } },
          trainingCenter: { select: { id: true, name: true } },
          affiliatedTrainingCenter: { select: { id: true, name: true } },
        },
      }),
      prisma.district.findMany({ orderBy: { name: 'asc' } }),
      prisma.trainingCenter.findMany({ orderBy: { name: 'asc' }, include: { district: { select: { name: true } } } }),
    ]);
    ok(res, { users, districts, centers });
  }),
);

const createUserSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  role: z.nativeEnum(RoleCode),
  districtId: z.string().uuid().optional().nullable(),
  trainingCenterId: z.string().uuid().optional().nullable(),
  affiliatedTrainingCenterId: z.string().uuid().optional().nullable(),
});

operationsRouter.post(
  '/admin/users',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const body = parse(createUserSchema, req.body);
    const exists = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (exists) throw conflict('A user with this email already exists');
    const created = await prisma.user.create({
      data: {
        name: body.name.trim(),
        email: body.email.toLowerCase().trim(),
        passwordHash: await hashPassword(body.password),
        role: body.role,
        districtId: body.districtId ?? null,
        trainingCenterId: body.trainingCenterId ?? null,
        affiliatedTrainingCenterId: body.affiliatedTrainingCenterId ?? null,
      },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    await audit({
      actor: req.user!,
      action: 'admin.user.created',
      resourceType: 'User',
      resourceId: created.id,
      metadata: { role: created.role },
      ip: clientIp(req),
    });
    ok(res, created, undefined, 201);
  }),
);

const patchUserSchema = z.object({
  isActive: z.boolean().optional(),
  role: z.nativeEnum(RoleCode).optional(),
  districtId: z.string().uuid().optional().nullable(),
  trainingCenterId: z.string().uuid().optional().nullable(),
});

operationsRouter.patch(
  '/admin/users/:id',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(patchUserSchema, req.body);
    const updated = await prisma.user.update({
      where: { id },
      data: body,
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    await audit({
      actor: req.user!,
      action: 'admin.user.updated',
      resourceType: 'User',
      resourceId: id,
      metadata: body as Prisma.InputJsonValue,
      ip: clientIp(req),
    });
    ok(res, updated);
  }),
);

operationsRouter.get(
  '/admin/health',
  requireAuth,
  requireRole('SUPER_ADMIN', 'STATE_OFFICER'),
  asyncHandler(async (_req, res) => {
    const [dbOk, redis, workers, outboxCounts, deliveryCounts, busStats] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => 'up' as const).catch(() => 'down' as const),
      redisPing(),
      prisma.workerHeartbeat.findMany({ orderBy: { name: 'asc' } }),
      prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.deliveryJob.groupBy({ by: ['status'], _count: { _all: true } }),
      currentBus()?.queueStats() ?? Promise.resolve([]),
    ]);
    ok(res, {
      database: dbOk,
      redis,
      broker: {
        driver: currentBus()?.driver ?? env.QUEUE_DRIVER,
        connected: currentBus()?.isConnected() ?? false,
        queues: busStats,
      },
      workers,
      outbox: Object.fromEntries(outboxCounts.map((o) => [o.status, o._count._all])),
      delivery: Object.fromEntries(deliveryCounts.map((d) => [d.status, d._count._all])),
    });
  }),
);

operationsRouter.post(
  '/admin/demo/reset',
  requireAuth,
  requireRole('SUPER_ADMIN'),
  asyncHandler(async (req, res) => {
    if (!env.DEMO_MODE) throw conflict('Demo reset is disabled when DEMO_MODE is false');
    const { seedDemoData } = await import('../seed/seed.js');
    await seedDemoData(true);
    const reseededActor = await prisma.user.findUnique({ where: { email: req.user!.email } });
    await audit({
      actor: reseededActor ? { id: reseededActor.id, role: reseededActor.role } : null,
      action: 'admin.demo.reset',
      resourceType: 'System',
      ip: clientIp(req),
    });
    ok(res, { reset: true, reloginRequired: true });
  }),
);
