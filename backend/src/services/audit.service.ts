import type { Prisma, RoleCode } from '@prisma/client';
import { prisma, type Tx } from '../lib/prisma.js';

export interface Actor {
  id: string;
  role: RoleCode;
}

export interface AuditInput {
  actor?: Actor | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  batchId?: string | null;
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

/** Append-only audit trail. A database trigger blocks UPDATE/DELETE on AuditLog rows. */
export async function audit(input: AuditInput, tx: Tx = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: input.actor?.id ?? null,
      actorRole: input.actor?.role ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      batchId: input.batchId ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata ?? undefined,
      ip: input.ip ?? null,
    },
  });
}
