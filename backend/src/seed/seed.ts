import fs from 'node:fs/promises';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { hashPassword } from '../services/auth.service.js';
import { ensureConfigDefaults } from '../services/config.service.js';
import { generateCertificatesForBatch } from '../services/certificate.service.js';
import { processDeliveryJob } from '../services/delivery.service.js';
import { certificateStorageRoot } from '../services/pdf.service.js';
import { audit } from '../services/audit.service.js';

const FIRST_NAMES = [
  'Aarav', 'Bhavna', 'Chetan', 'Divya', 'Eshan', 'Fatima', 'Gaurav', 'Harsha', 'Ishaan', 'Jyoti',
  'Karan', 'Lavanya', 'Manish', 'Nandini', 'Omkar', 'Pooja', 'Qasim', 'Ritu', 'Siddharth', 'Tanvi',
  'Uday', 'Vaishnavi', 'Waseem', 'Yamini', 'Zoya', 'Aditya', 'Chitra', 'Deepak', 'Gauri', 'Hemant',
];
const LAST_NAMES = [
  'Kulkarni', 'Deshmukh', 'Patil', 'Joshi', 'Sharma', 'Verma', 'Nair', 'Rao', 'Sheikh', 'Bhosale',
  'Chavan', 'Pawar', 'Gokhale', 'Sawant', 'More', 'Jadhav', 'Kale', 'Shinde', 'Tiwari', 'Mishra',
];

function makeCandidates(count: number, courseName: string, completionDate: Date, phoneBase: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(i / 2) % LAST_NAMES.length];
    const num = phoneBase + i;
    return {
      rowNumber: i + 2,
      externalId: `${prefix}-${String(i + 1).padStart(3, '0')}`,
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}.${prefix.toLowerCase()}${i + 1}@example.in`,
      phone: `+91${num}`,
      courseName,
      completionDate,
    };
  });
}

export async function seedDemoData(reset = false) {
  if (reset) {
    // Delete in reverse FK order (AuditLog is append-only in prod; trigger allows TRUNCATE for demo reset)
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE
        "DeliveryAttempt",
        "DeliveryJob",
        "MockWhatsAppMessage",
        "Certificate",
        "BatchApproval",
        "BatchEscalation",
        "Candidate",
        "Batch",
        "OutboxEvent",
        "ProcessedEvent",
        "AuditLog",
        "Session",
        "User",
        "TrainingCenter",
        "District",
        "WorkerHeartbeat"
      RESTART IDENTITY CASCADE
    `);
    await fs.rm(certificateStorageRoot(), { recursive: true, force: true }).catch(() => undefined);
  }

  // 1. Roles
  const roles = [
    { code: 'TRAINING_CENTER' as const, name: 'Training Center Coordinator', description: 'Creates batches, uploads candidates, submits for approval' },
    { code: 'DISTRICT_OFFICER' as const, name: 'District Skilling Officer', description: 'Reviews and approves batches within assigned district (2 required)' },
    { code: 'QUALITY_OFFICER' as const, name: 'Quality Assurance Officer', description: 'Performs quality inspection on large batches (>= threshold)' },
    { code: 'STATE_OFFICER' as const, name: 'State Approving Officer', description: 'Final issuance approval, certificate cancellation, escalation oversight' },
    { code: 'SUPER_ADMIN' as const, name: 'System Super Administrator', description: 'Manages users, system configuration, audit logs, and worker health' },
  ];
  for (const r of roles) {
    await prisma.role.upsert({ where: { code: r.code }, update: { name: r.name, description: r.description }, create: r });
  }

  await ensureConfigDefaults();

  // 2. Districts
  const pune = await prisma.district.upsert({
    where: { code: 'PUN' },
    update: {},
    create: { code: 'PUN', name: 'Pune', state: 'Maharashtra' },
  });
  const nagpur = await prisma.district.upsert({
    where: { code: 'NAG' },
    update: {},
    create: { code: 'NAG', name: 'Nagpur', state: 'Maharashtra' },
  });

  // 3. Training Centers
  const pvcPune = await prisma.trainingCenter.upsert({
    where: { code: 'PVC-PUN' },
    update: {},
    create: {
      code: 'PVC-PUN',
      name: 'Pragati Vocational Center, Pune',
      address: 'Plot 14, Shivajinagar Skill Park, Pune 411005',
      districtId: pune.id,
    },
  });
  const sshPune = await prisma.trainingCenter.upsert({
    where: { code: 'SSH-PUN' },
    update: {},
    create: {
      code: 'SSH-PUN',
      name: 'Sahyadri Skill Hub, Pune',
      address: 'Sector 8, Pimpri Industrial Area, Pune 411018',
      districtId: pune.id,
    },
  });
  const vtiNagpur = await prisma.trainingCenter.upsert({
    where: { code: 'VTI-NAG' },
    update: {},
    create: {
      code: 'VTI-NAG',
      name: 'Vidarbha Technical Institute, Nagpur',
      address: 'MIHAN Education Zone, Nagpur 441108',
      districtId: nagpur.id,
    },
  });

  // 4. Demo Users (bcrypt hashed)
  const passwordHash = await hashPassword(env.DEMO_PASSWORD);
  const upsertUser = (data: {
    email: string;
    name: string;
    role: 'TRAINING_CENTER' | 'DISTRICT_OFFICER' | 'QUALITY_OFFICER' | 'STATE_OFFICER' | 'SUPER_ADMIN';
    districtId?: string;
    trainingCenterId?: string;
    affiliatedTrainingCenterId?: string;
  }) =>
    prisma.user.upsert({
      where: { email: data.email },
      update: {
        name: data.name,
        role: data.role,
        districtId: data.districtId ?? null,
        trainingCenterId: data.trainingCenterId ?? null,
        affiliatedTrainingCenterId: data.affiliatedTrainingCenterId ?? null,
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
      create: {
        email: data.email,
        name: data.name,
        passwordHash,
        role: data.role,
        districtId: data.districtId ?? null,
        trainingCenterId: data.trainingCenterId ?? null,
        affiliatedTrainingCenterId: data.affiliatedTrainingCenterId ?? null,
      },
    });

  const anika = await upsertUser({
    email: 'anika@certiflow.gov.in',
    name: 'Anika Sharma',
    role: 'TRAINING_CENTER',
    districtId: pune.id,
    trainingCenterId: pvcPune.id,
  });
  const rohan = await upsertUser({
    email: 'rohan@certiflow.gov.in',
    name: 'Rohan Deshpande',
    role: 'TRAINING_CENTER',
    districtId: pune.id,
    trainingCenterId: sshPune.id,
  });
  const dev = await upsertUser({
    email: 'dev@certiflow.gov.in',
    name: 'Dev Kulkarni',
    role: 'DISTRICT_OFFICER',
    districtId: pune.id,
  });
  const meera = await upsertUser({
    email: 'meera@certiflow.gov.in',
    name: 'Meera Joshi',
    role: 'DISTRICT_OFFICER',
    districtId: pune.id,
  });
  const kabir = await upsertUser({
    email: 'kabir@certiflow.gov.in',
    name: 'Kabir Deshmukh',
    role: 'DISTRICT_OFFICER',
    districtId: nagpur.id,
    affiliatedTrainingCenterId: vtiNagpur.id, // Conflict-of-interest demo for VTI-NAG
  });
  const neha = await upsertUser({
    email: 'neha@certiflow.gov.in',
    name: 'Neha Iyer',
    role: 'QUALITY_OFFICER',
  });
  const farah = await upsertUser({
    email: 'farah@certiflow.gov.in',
    name: 'Farah Khan',
    role: 'STATE_OFFICER',
  });
  const admin = await upsertUser({
    email: 'admin@certiflow.gov.in',
    name: 'System Admin',
    role: 'SUPER_ADMIN',
  });

  // Skip batch creation if demo batches already exist and not resetting
  const existingBatchCount = await prisma.batch.count();
  if (existingBatchCount > 0 && !reset) {
    return { skipped: true };
  }

  const d1 = new Date(Date.UTC(2026, 9, 15));
  const d2 = new Date(Date.UTC(2026, 10, 1));
  const d3 = new Date(Date.UTC(2026, 10, 10));

  // Batch 1: DRAFT (Anika) — ready to upload candidates
  await prisma.batch.create({
    data: {
      code: 'PSM-PVCPUN-202611-DRF1',
      title: 'Solar PV Technician — November Cohort',
      courseName: 'Solar PV Installation Technician',
      courseCode: 'SOL-101',
      trainingCenterId: pvcPune.id,
      districtId: pune.id,
      completionDate: d3,
      status: 'DRAFT',
      version: 1,
      candidateCount: 0,
      createdById: anika.id,
    },
  });

  // Batch 2: DISTRICT_REVIEW (Anika, 12 candidates, 0 approvals — ready for Dev + Meera)
  const bDistPending = await prisma.batch.create({
    data: {
      code: 'PSM-PVCPUN-202611-DST1',
      title: 'CNC Machine Operator — Batch A',
      courseName: 'CNC Turning & Milling Operator',
      courseCode: 'CNC-204',
      trainingCenterId: pvcPune.id,
      districtId: pune.id,
      completionDate: d2,
      status: 'DISTRICT_REVIEW',
      version: 1,
      candidateCount: 12,
      requiresQuality: false,
      submittedAt: new Date(Date.now() - 12 * 60_000),
      stageEnteredAt: new Date(Date.now() - 12 * 60_000),
      createdById: anika.id,
      candidates: { create: makeCandidates(12, 'CNC Turning & Milling Operator', d2, 9820100100, 'CNC') },
    },
  });

  // Batch 3: QUALITY_REVIEW (Anika, 55 candidates, 2 district approvals — ready for Neha!)
  const bQualityPending = await prisma.batch.create({
    data: {
      code: 'PSM-PVCPUN-202611-QLT1',
      title: 'Full-Stack Web Associate — Large Cohort (55)',
      courseName: 'Junior Software & Web Developer',
      courseCode: 'IT-302',
      trainingCenterId: pvcPune.id,
      districtId: pune.id,
      completionDate: d2,
      status: 'QUALITY_REVIEW',
      version: 1,
      candidateCount: 55,
      requiresQuality: true,
      submittedAt: new Date(Date.now() - 20 * 60_000),
      stageEnteredAt: new Date(Date.now() - 10 * 60_000),
      createdById: anika.id,
      candidates: { create: makeCandidates(55, 'Junior Software & Web Developer', d2, 9820200100, 'WEB') },
      approvals: {
        create: [
          { version: 1, stage: 'DISTRICT', decision: 'APPROVE', reviewerId: dev.id, reason: 'Attendance registers verified' },
          { version: 1, stage: 'DISTRICT', decision: 'APPROVE', reviewerId: meera.id, reason: 'Assessment marksheets matched' },
        ],
      },
    },
  });

  // Batch 4: STATE_REVIEW (Anika, 15 candidates, 2 district approvals — ready for Farah!)
  const bStatePending = await prisma.batch.create({
    data: {
      code: 'PSM-PVCPUN-202611-ST01',
      title: 'Healthcare Nursing Assistant — Cohort 4',
      courseName: 'General Duty Healthcare Assistant',
      courseCode: 'HLT-110',
      trainingCenterId: pvcPune.id,
      districtId: pune.id,
      completionDate: d1,
      status: 'STATE_REVIEW',
      version: 1,
      candidateCount: 15,
      requiresQuality: false,
      submittedAt: new Date(Date.now() - 25 * 60_000),
      stageEnteredAt: new Date(Date.now() - 8 * 60_000),
      createdById: anika.id,
      candidates: { create: makeCandidates(15, 'General Duty Healthcare Assistant', d1, 9820300100, 'HLT') },
      approvals: {
        create: [
          { version: 1, stage: 'DISTRICT', decision: 'APPROVE', reviewerId: dev.id, reason: 'Verified' },
          { version: 1, stage: 'DISTRICT', decision: 'APPROVE', reviewerId: meera.id, reason: 'Approved for state review' },
        ],
      },
    },
  });

  // Batch 5: RETURNED (Anika, 6 candidates — ready to edit & resubmit)
  const bReturned = await prisma.batch.create({
    data: {
      code: 'PSM-PVCPUN-202611-RET1',
      title: 'Industrial Electrician — Batch B',
      courseName: 'Industrial Wiring & Safety Electrician',
      courseCode: 'ELC-105',
      trainingCenterId: pvcPune.id,
      districtId: pune.id,
      completionDate: d1,
      status: 'RETURNED',
      version: 1,
      candidateCount: 6,
      requiresQuality: false,
      returnReason: 'Completion date on assessment sheet does not match uploaded candidate records. Please correct and resubmit.',
      submittedAt: new Date(Date.now() - 90 * 60_000),
      stageEnteredAt: new Date(Date.now() - 40 * 60_000),
      createdById: anika.id,
      candidates: { create: makeCandidates(6, 'Industrial Wiring & Safety Electrician', d1, 9820400100, 'ELC') },
      approvals: {
        create: [
          {
            version: 1,
            stage: 'DISTRICT',
            decision: 'RETURN',
            reviewerId: dev.id,
            reason: 'Completion date on assessment sheet does not match uploaded candidate records. Please correct and resubmit.',
          },
        ],
      },
    },
  });

  // Batch 6: STUCK + ESCALATED (Sahyadri Skill Hub Pune, Rohan's center — also demonstrates center isolation!)
  const bStuck = await prisma.batch.create({
    data: {
      code: 'PSM-SSHPUN-202611-ESC1',
      title: 'EV Battery Diagnostics — Cohort 2',
      courseName: 'Electric Vehicle Battery Technician',
      courseCode: 'EV-201',
      trainingCenterId: sshPune.id,
      districtId: pune.id,
      completionDate: d1,
      status: 'DISTRICT_REVIEW',
      version: 1,
      candidateCount: 10,
      requiresQuality: false,
      submittedAt: new Date(Date.now() - 65 * 60_000),
      stageEnteredAt: new Date(Date.now() - 65 * 60_000),
      createdById: rohan.id,
      candidates: { create: makeCandidates(10, 'Electric Vehicle Battery Technician', d1, 9820500100, 'EVB') },
      escalations: {
        create: {
          version: 1,
          stage: 'DISTRICT_REVIEW',
          status: 'OPEN',
          responsibleRole: 'DISTRICT_OFFICER',
          elapsedMinutes: 65,
          slaMinutes: 30,
          message: 'Batch PSM-SSHPUN-202611-ESC1 (EV Battery Diagnostics — Cohort 2) has been pending in DISTRICT_REVIEW for 65m (SLA: 30m)',
        },
      },
    },
  });

  // Batch 7: Nagpur District Batch (demonstrates cross-district isolation — Pune officers cannot see it)
  await prisma.batch.create({
    data: {
      code: 'PSM-VTINAG-202611-NAG1',
      title: 'Agri-Drone Operations — Vidarbha Cohort',
      courseName: 'Agricultural Drone Pilot',
      courseCode: 'AGR-401',
      trainingCenterId: vtiNagpur.id,
      districtId: nagpur.id,
      completionDate: d2,
      status: 'DISTRICT_REVIEW',
      version: 1,
      candidateCount: 8,
      requiresQuality: false,
      submittedAt: new Date(Date.now() - 15 * 60_000),
      stageEnteredAt: new Date(Date.now() - 15 * 60_000),
      createdById: admin.id,
      candidates: { create: makeCandidates(8, 'Agricultural Drone Pilot', d2, 9820600100, 'AGR') },
    },
  });

  // Batch 8: APPROVED -> Generate real PDF certificates + run mock WhatsApp deliveries (mix of SENT, RETRYING, CANCELLED)
  const bIssued = await prisma.batch.create({
    data: {
      code: 'PSM-PVCPUN-202610-ISS1',
      title: 'Data Entry & Digital Literacy — October Cohort',
      courseName: 'Domestic Data Entry Operator',
      courseCode: 'DEO-100',
      trainingCenterId: pvcPune.id,
      districtId: pune.id,
      completionDate: d1,
      status: 'APPROVED',
      version: 1,
      candidateCount: 8,
      requiresQuality: false,
      submittedAt: new Date(Date.now() - 48 * 3600_000),
      approvedAt: new Date(Date.now() - 24 * 3600_000),
      stageEnteredAt: new Date(Date.now() - 24 * 3600_000),
      createdById: anika.id,
      // Phones 9820700100..9820700107 include endings '3' (mock failure -> RETRYING) and '7' (mock timeout -> RETRYING)
      candidates: { create: makeCandidates(8, 'Domestic Data Entry Operator', d1, 9820700100, 'DEO') },
      approvals: {
        create: [
          { version: 1, stage: 'DISTRICT', decision: 'APPROVE', reviewerId: dev.id, reason: 'All records verified' },
          { version: 1, stage: 'DISTRICT', decision: 'APPROVE', reviewerId: meera.id, reason: 'District clearance granted' },
          { version: 1, stage: 'STATE', decision: 'APPROVE', reviewerId: farah.id, reason: 'Approved for certificate issuance' },
        ],
      },
    },
  });

  // Generate actual PDFs and delivery jobs for Batch 8
  await generateCertificatesForBatch(bIssued.id);

  // Process the 8 delivery jobs once so SENT and RETRYING states are immediately visible
  const jobs = await prisma.deliveryJob.findMany({
    where: { certificate: { batchId: bIssued.id } },
    orderBy: { createdAt: 'asc' },
  });
  for (const job of jobs) {
    await processDeliveryJob(job.id);
  }

  // Cancel the last certificate so demo immediately shows a CANCELLED certificate too
  const certs = await prisma.certificate.findMany({
    where: { batchId: bIssued.id },
    orderBy: { certificateNumber: 'asc' },
  });
  const lastCert = certs[certs.length - 1];
  if (lastCert) {
    await prisma.certificate.update({
      where: { id: lastCert.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(Date.now() - 2 * 3600_000),
        cancelledById: farah.id,
        cancelReason: 'Duplicate enrolment detected during post-issuance audit',
      },
    });
    await prisma.deliveryJob.updateMany({
      where: { certificateId: lastCert.id },
      data: { status: 'CANCELLED', lastError: 'Certificate cancelled during post-issuance audit' },
    });
    await audit({
      actor: farah,
      action: 'certificate.cancelled',
      resourceType: 'Certificate',
      resourceId: lastCert.id,
      batchId: bIssued.id,
      reason: 'Duplicate enrolment detected during post-issuance audit',
      metadata: { certificateNumber: lastCert.certificateNumber, previousStatus: 'ISSUED', newStatus: 'CANCELLED' },
    });
  }

  // Seed baseline audit entries for demo batches
  await audit({ actor: anika, action: 'batch.submitted', resourceType: 'Batch', resourceId: bDistPending.id, batchId: bDistPending.id, metadata: { candidateCount: 12 } });
  await audit({ actor: dev, action: 'batch.district.approve', resourceType: 'Batch', resourceId: bQualityPending.id, batchId: bQualityPending.id });
  await audit({ actor: meera, action: 'batch.district.approve', resourceType: 'Batch', resourceId: bQualityPending.id, batchId: bQualityPending.id });
  await audit({ actor: meera, action: 'batch.district.approve', resourceType: 'Batch', resourceId: bStatePending.id, batchId: bStatePending.id });
  await audit({ actor: dev, action: 'batch.district.return', resourceType: 'Batch', resourceId: bReturned.id, batchId: bReturned.id, reason: bReturned.returnReason });
  await audit({ action: 'batch.escalated', resourceType: 'BatchEscalation', resourceId: bStuck.id, batchId: bStuck.id, metadata: { stage: 'DISTRICT_REVIEW', elapsedMinutes: 65 } });
  await audit({ actor: neha, action: 'system.seeded', resourceType: 'System', metadata: { demoMode: true } });
  await audit({ actor: admin, action: 'system.initialized', resourceType: 'System', metadata: { users: 8, batches: 8 } });

  // Mark seed outbox events as already published so fresh boot doesn't flood historical alerts
  await prisma.outboxEvent.updateMany({
    where: { status: 'PENDING' },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  return { seeded: true, users: 8, batches: 8, certificates: certs.length };
}
