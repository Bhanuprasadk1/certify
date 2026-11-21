import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pgPool, prisma } from '../src/lib/prisma.js';
import { seedDemoData } from '../src/seed/seed.js';
import { generateCertificatesForBatch } from '../src/services/certificate.service.js';
import { processDeliveryJob } from '../src/services/delivery.service.js';
import { scanStuckBatches } from '../src/services/escalation.service.js';
import { env } from '../src/config/env.js';

const app = createApp();
const PW = env.DEMO_PASSWORD;

async function loginAs(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login failed for ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.data.accessToken as string;
}

describe('CertiFlow End-to-End Integration, Security & Concurrency Suite', () => {
  let anikaToken: string;
  let rohanToken: string;
  let devToken: string;
  let meeraToken: string;
  let kabirToken: string;
  let nehaToken: string;
  let farahToken: string;
  let adminToken: string;

  beforeAll(async () => {
    await seedDemoData(true);
    [anikaToken, rohanToken, devToken, meeraToken, kabirToken, nehaToken, farahToken, adminToken] = await Promise.all([
      loginAs('anika@certiflow.gov.in'),
      loginAs('rohan@certiflow.gov.in'),
      loginAs('dev@certiflow.gov.in'),
      loginAs('meera@certiflow.gov.in'),
      loginAs('kabir@certiflow.gov.in'),
      loginAs('neha@certiflow.gov.in'),
      loginAs('farah@certiflow.gov.in'),
      loginAs('admin@certiflow.gov.in'),
    ]);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pgPool.end();
  });

  it('Authentication: rejects unauthenticated calls, bad passwords, and supports refresh + logout', async () => {
    const unauth = await request(app).get('/api/batches');
    expect(unauth.status).toBe(401);

    const badLogin = await request(app).post('/api/auth/login').send({ email: 'anika@certiflow.gov.in', password: 'WrongPassword!' });
    expect(badLogin.status).toBe(401);

    const freshLogin = await request(app).post('/api/auth/login').send({ email: 'anika@certiflow.gov.in', password: PW });
    expect(freshLogin.status).toBe(200);
    const tok = freshLogin.body.data.accessToken as string;
    const cookies = freshLogin.headers['set-cookie'];

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tok}`);
    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe('TRAINING_CENTER');

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookies);
    expect(refreshed.status).toBe(200);
    const newTok = refreshed.body.data.accessToken as string;

    await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${newTok}`);
    const afterLogout = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${newTok}`);
    expect(afterLogout.status).toBe(401);
  });

  it('Scenario 7 — Authorization Attacks & Data Isolation (cross-center, cross-district, RBAC, COI)', async () => {
    const sshBatch = await prisma.batch.findFirstOrThrow({ where: { code: 'PSM-SSHPUN-202611-ESC1' } });
    const nagBatch = await prisma.batch.findFirstOrThrow({ where: { code: 'PSM-VTINAG-202611-NAG1' } });
    const pvcDistBatch = await prisma.batch.findFirstOrThrow({ where: { code: 'PSM-PVCPUN-202611-DST1' } });
    const stateBatch = await prisma.batch.findFirstOrThrow({ where: { code: 'PSM-PVCPUN-202611-ST01' } });
    const issuedCert = await prisma.certificate.findFirstOrThrow({ where: { status: 'ISSUED' } });

    // 1. Anika (PVC-PUN) cannot view Rohan's (SSH-PUN) batch
    const crossCenter = await request(app).get(`/api/batches/${sshBatch.id}`).set('Authorization', `Bearer ${anikaToken}`);
    expect(crossCenter.status).toBe(404);

    // 2. Rohan (SSH-PUN) cannot download certificate belonging to Anika's center
    const crossCertDl = await request(app)
      .get(`/api/certificates/${issuedCert.id}/download`)
      .set('Authorization', `Bearer ${rohanToken}`);
    expect(crossCertDl.status).toBe(404);

    // 3. Dev (Pune) cannot view or approve Nagpur batch
    const crossDistrictRead = await request(app).get(`/api/batches/${nagBatch.id}`).set('Authorization', `Bearer ${devToken}`);
    expect(crossDistrictRead.status).toBe(404);
    const crossDistrictApprove = await request(app)
      .post(`/api/batches/${nagBatch.id}/district-decision`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ decision: 'APPROVE' });
    expect(crossDistrictApprove.status).toBe(403);

    // 4. Conflict of Interest: Kabir is affiliated with VTI-NAG and cannot approve VTI-NAG's batch
    const coiApprove = await request(app)
      .post(`/api/batches/${nagBatch.id}/district-decision`)
      .set('Authorization', `Bearer ${kabirToken}`)
      .send({ decision: 'APPROVE' });
    expect(coiApprove.status).toBe(403);
    expect(coiApprove.body.message.toLowerCase()).toContain('conflict of interest');

    // 5. Training Center cannot approve
    const tcApprove = await request(app)
      .post(`/api/batches/${pvcDistBatch.id}/district-decision`)
      .set('Authorization', `Bearer ${anikaToken}`)
      .send({ decision: 'APPROVE' });
    expect(tcApprove.status).toBe(403);

    // 6. District Officer cannot perform State approval
    const distState = await request(app)
      .post(`/api/batches/${stateBatch.id}/state-decision`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ decision: 'APPROVE' });
    expect(distState.status).toBe(403);

    // 7. Quality Officer cannot cancel a certificate
    const qualCancel = await request(app)
      .post(`/api/certificates/${issuedCert.id}/cancel`)
      .set('Authorization', `Bearer ${nehaToken}`)
      .send({ reason: 'Unauthorized attempt' });
    expect(qualCancel.status).toBe(403);
  });

  it('Scenario 1 — Atomic CSV Upload: rejects invalid CSV completely with row errors and saves zero candidates', async () => {
    const createRes = await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${anikaToken}`)
      .send({
        title: 'Atomic Upload Test Batch',
        courseName: 'Welding Technician',
        courseCode: 'WLD-101',
        completionDate: '2026-11-15',
      });
    expect(createRes.status).toBe(201);
    const batchId = createRes.body.data.id as string;

    const badCsv = [
      'name,email,phone,course,completion_date,candidate_id',
      'Valid Candidate,valid@example.in,9876500001,Welding Technician,2026-11-15,W-001',
      ',missingname@example.in,9876500002,Welding Technician,2026-11-15,W-002',
      'Bad Phone User,badphone@example.in,12345,Welding Technician,2026-11-15,W-003',
      'Bad Email User,not-an-email,9876500004,Welding Technician,2026-11-15,W-004',
      'Duplicate Phone,dup@example.in,9876500001,Welding Technician,2026-11-15,W-005',
    ].join('\n');

    const failUpload = await request(app)
      .post(`/api/batches/${batchId}/upload`)
      .set('Authorization', `Bearer ${anikaToken}`)
      .attach('file', Buffer.from(badCsv), 'invalid.csv');

    expect(failUpload.status).toBe(422);
    expect(failUpload.body.success).toBe(false);
    expect(failUpload.body.errors.length).toBeGreaterThanOrEqual(4);
    expect(failUpload.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, field: 'name' }),
        expect.objectContaining({ row: 4, field: 'phone' }),
        expect.objectContaining({ row: 5, field: 'email' }),
        expect.objectContaining({ row: 6, field: 'phone' }),
      ]),
    );

    // Crucial: ZERO candidates saved in database!
    const countAfterFail = await prisma.candidate.count({ where: { batchId } });
    expect(countAfterFail).toBe(0);

    // Valid CSV succeeds atomically
    const goodCsv = [
      'name,email,phone,course,completion_date,candidate_id',
      'Kiran Rao,kiran@example.in,9876500011,Welding Technician,2026-11-15,W-011',
      'Sneha Patwardhan,sneha@example.in,9876500012,Welding Technician,2026-11-15,W-012',
    ].join('\n');
    const okUpload = await request(app)
      .post(`/api/batches/${batchId}/upload`)
      .set('Authorization', `Bearer ${anikaToken}`)
      .attach('file', Buffer.from(goodCsv), 'valid.csv');
    expect(okUpload.status).toBe(200);
    expect(okUpload.body.data.uploadedCount).toBe(2);
  });

  it('Scenario 2 — Concurrent District Approvals: safe locking, single stage transition, single outbox event', async () => {
    const batch = await prisma.batch.findFirstOrThrow({ where: { code: 'PSM-PVCPUN-202611-DST1' } });

    // Dev and Meera approve concurrently
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/batches/${batch.id}/district-decision`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ decision: 'APPROVE', reason: 'Concurrent check 1' }),
      request(app)
        .post(`/api/batches/${batch.id}/district-decision`)
        .set('Authorization', `Bearer ${meeraToken}`)
        .send({ decision: 'APPROVE', reason: 'Concurrent check 2' }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Exactly ONE of the two requests triggered the transition
    const progressedCount = [r1.body.data.progressed, r2.body.data.progressed].filter(Boolean).length;
    expect(progressedCount).toBe(1);

    const updated = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(updated.status).toBe('STATE_REVIEW'); // 12 candidates < 50 -> skips quality

    const approvals = await prisma.batchApproval.findMany({ where: { batchId: batch.id, version: 1, stage: 'DISTRICT' } });
    expect(approvals).toHaveLength(2);

    const distEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: batch.id, eventType: 'batch.district.approved' },
    });
    expect(distEvents).toHaveLength(1);

    // Re-approving by Dev is rejected
    const dup = await request(app)
      .post(`/api/batches/${batch.id}/district-decision`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ decision: 'APPROVE' });
    expect(dup.status).toBe(409);
  });

  it('Scenario 6 — Return & Resubmit: increments version and ignores prior version approvals', async () => {
    const retBatch = await prisma.batch.findFirstOrThrow({ where: { code: 'PSM-PVCPUN-202611-RET1' } });
    expect(retBatch.status).toBe('RETURNED');
    expect(retBatch.version).toBe(1);

    // Anika edits and resubmits
    const editRes = await request(app)
      .put(`/api/batches/${retBatch.id}`)
      .set('Authorization', `Bearer ${anikaToken}`)
      .send({ title: 'Industrial Electrician — Batch B (Corrected)' });
    expect(editRes.status).toBe(200);

    const resubRes = await request(app)
      .post(`/api/batches/${retBatch.id}/resubmit`)
      .set('Authorization', `Bearer ${anikaToken}`);
    expect(resubRes.status).toBe(200);
    expect(resubRes.body.data.version).toBe(2);
    expect(resubRes.body.data.status).toBe('DISTRICT_REVIEW');

    // Old v1 decision remains in DB history
    const v1History = await prisma.batchApproval.count({ where: { batchId: retBatch.id, version: 1 } });
    expect(v1History).toBe(1);

    // Dev can approve v2, and batch stays in DISTRICT_REVIEW (needs 2 fresh approvals for v2)
    const devApproveV2 = await request(app)
      .post(`/api/batches/${retBatch.id}/district-decision`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ decision: 'APPROVE', reason: 'Corrections verified for v2' });
    expect(devApproveV2.status).toBe(200);
    expect(devApproveV2.body.data.progressed).toBe(false);
    expect(devApproveV2.body.data.nextStatus).toBe('DISTRICT_REVIEW');
  });

  it('Scenarios 3 & 8 — 60 Candidates: Quality Review, State Approval, Idempotent Generation & Delivery Retries', async () => {
    // 1. Create batch & upload 60 candidates
    const batchRes = await request(app)
      .post('/api/batches')
      .set('Authorization', `Bearer ${anikaToken}`)
      .send({
        title: 'Cloud Infrastructure — 60 Candidate Cohort',
        courseName: 'Cloud Infrastructure Associate',
        courseCode: 'CLD-300',
        completionDate: '2026-11-12',
      });
    expect(batchRes.status).toBe(201);
    const batchId = batchRes.body.data.id as string;

    const csvRows = ['name,email,phone,course,completion_date,candidate_id'];
    for (let i = 1; i <= 60; i++) {
      csvRows.push(`Candidate ${i},c${i}@example.in,${9812000000 + i},Cloud Infrastructure Associate,2026-11-12,CLD-${i}`);
    }
    const upRes = await request(app)
      .post(`/api/batches/${batchId}/upload`)
      .set('Authorization', `Bearer ${anikaToken}`)
      .attach('file', Buffer.from(csvRows.join('\n')), '60-candidates.csv');
    expect(upRes.status).toBe(200);
    expect(upRes.body.data.uploadedCount).toBe(60);
    expect(upRes.body.data.requiresQuality).toBe(true);

    // 2. Submit
    const subRes = await request(app).post(`/api/batches/${batchId}/submit`).set('Authorization', `Bearer ${anikaToken}`);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.status).toBe('DISTRICT_REVIEW');

    // 3. Two district approvals -> routes to QUALITY_REVIEW (not STATE_REVIEW)
    await request(app).post(`/api/batches/${batchId}/district-decision`).set('Authorization', `Bearer ${devToken}`).send({ decision: 'APPROVE' });
    const secondDist = await request(app)
      .post(`/api/batches/${batchId}/district-decision`)
      .set('Authorization', `Bearer ${meeraToken}`)
      .send({ decision: 'APPROVE' });
    expect(secondDist.status).toBe(200);
    expect(secondDist.body.data.nextStatus).toBe('QUALITY_REVIEW');

    // 4. Quality approval -> routes to STATE_REVIEW
    const qualRes = await request(app)
      .post(`/api/batches/${batchId}/quality-decision`)
      .set('Authorization', `Bearer ${nehaToken}`)
      .send({ decision: 'APPROVE', reason: 'Sampled 10 candidates, all records match' });
    expect(qualRes.status).toBe(200);
    expect(qualRes.body.data.nextStatus).toBe('STATE_REVIEW');

    // 5. State approval -> APPROVED
    const stateRes = await request(app)
      .post(`/api/batches/${batchId}/state-decision`)
      .set('Authorization', `Bearer ${farahToken}`)
      .send({ decision: 'APPROVE', reason: 'Final state approval' });
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.data.nextStatus).toBe('APPROVED');

    // 6. Generate certificates AND replay generation immediately to verify Scenario 8 Idempotency
    const firstGen = await generateCertificatesForBatch(batchId);
    expect(firstGen.total).toBe(60);
    expect(firstGen.created).toBe(60);
    expect(firstGen.deliveryJobsCreated).toBe(60);

    const replayGen = await generateCertificatesForBatch(batchId);
    expect(replayGen.created).toBe(0);
    expect(replayGen.reused).toBe(60);
    expect(replayGen.deliveryJobsCreated).toBe(0);

    expect(await prisma.certificate.count({ where: { batchId } })).toBe(60);
    expect(await prisma.deliveryJob.count({ where: { certificate: { batchId } } })).toBe(60);

    // 7. Test WhatsApp delivery retry + idempotency on a timeout-digit phone (...7)
    const timeoutJob = await prisma.deliveryJob.findFirstOrThrow({
      where: { certificate: { batchId, candidate: { phone: { endsWith: '7' } } } },
    });
    const attempt1 = await processDeliveryJob(timeoutJob.id);
    expect(attempt1.status).toBe('RETRYING');

    // Move nextAttemptAt to now and process retry -> succeeds on attempt 2
    await prisma.deliveryJob.update({ where: { id: timeoutJob.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const attempt2 = await processDeliveryJob(timeoutJob.id);
    expect(attempt2.status).toBe('SENT');

    // Replaying an already SENT job does nothing and keeps exactly 1 MockWhatsAppMessage
    const attempt3 = await processDeliveryJob(timeoutJob.id);
    expect(attempt3.status).toBe('SENT');
    expect(await prisma.mockWhatsAppMessage.count({ where: { idempotencyKey: timeoutJob.idempotencyKey } })).toBe(1);
  });

  it('Scenario 4 — Certificate Cancellation, Immediate Public Verification & Download Block', async () => {
    const cert = await prisma.certificate.findFirstOrThrow({ where: { status: 'ISSUED' } });

    // Before cancellation: public verify returns VALID with NO sensitive PII
    const before = await request(app).get(`/api/public/verify/${cert.verificationToken}`);
    expect(before.status).toBe(200);
    expect(before.body.data.status).toBe('VALID');
    expect(before.body.data.phone).toBeUndefined();
    expect(before.body.data.email).toBeUndefined();

    // Authorized download returns a real PDF
    const dlBefore = await request(app)
      .get(`/api/certificates/${cert.id}/download`)
      .set('Authorization', `Bearer ${farahToken}`);
    expect(dlBefore.status).toBe(200);
    expect(dlBefore.headers['content-type']).toContain('application/pdf');
    expect(dlBefore.body.subarray(0, 4).toString()).toBe('%PDF');

    // Farah cancels certificate
    const cancelRes = await request(app)
      .post(`/api/certificates/${cert.id}/cancel`)
      .set('Authorization', `Bearer ${farahToken}`)
      .send({ reason: 'Candidate assessment invalidated after audit' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('CANCELLED');

    // Public verification IMMEDIATELY returns CANCELLED (by token AND by certificate number)
    const afterByToken = await request(app).get(`/api/public/verify/${cert.verificationToken}`);
    expect(afterByToken.body.data.status).toBe('CANCELLED');
    const afterByNum = await request(app).get(`/api/public/verify/${cert.certificateNumber}`);
    expect(afterByNum.body.data.status).toBe('CANCELLED');

    // Download is blocked after cancellation
    const dlAfter = await request(app)
      .get(`/api/certificates/${cert.id}/download`)
      .set('Authorization', `Bearer ${farahToken}`);
    expect(dlAfter.status).toBe(410);

    // Invalid token returns INVALID
    const bad = await request(app).get('/api/public/verify/NONEXISTENT-CERT-999');
    expect(bad.body.data.status).toBe('INVALID');

    // Audit log captured cancellation with reason
    const auditRow = await prisma.auditLog.findFirst({ where: { resourceId: cert.id, action: 'certificate.cancelled' } });
    expect(auditRow?.reason).toContain('invalidated');
  });

  it('Scenario 5 — Stuck Batch Escalation & No Duplicate Escalations on Re-scan', async () => {
    const stateBatch = await prisma.batch.findFirstOrThrow({ where: { code: 'PSM-PVCPUN-202611-ST01' } });
    const sim = await request(app)
      .post(`/api/escalations/simulate/${stateBatch.id}`)
      .set('Authorization', `Bearer ${farahToken}`);
    expect(sim.status).toBe(200);
    expect(sim.body.data.escalation.stage).toBe('STATE_REVIEW');

    // Running scan again must NOT create duplicates
    const rescan = await scanStuckBatches();
    expect(rescan.created).toBe(0);

    const count = await prisma.batchEscalation.count({ where: { batchId: stateBatch.id } });
    expect(count).toBe(1);

    // Admin audit log endpoint works
    const logs = await request(app).get('/api/audit-logs?action=batch.escalated').set('Authorization', `Bearer ${adminToken}`);
    expect(logs.status).toBe(200);
    expect(logs.body.data.length).toBeGreaterThanOrEqual(1);
  });
});
