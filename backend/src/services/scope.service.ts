import type { Prisma } from '@prisma/client';
import type { AuthUser } from './auth.service.js';

/**
 * Server-side data scoping. Every list/detail query for batches (and anything hanging off a batch)
 * is filtered with these predicates derived from the authenticated identity — never from client input.
 */
export function batchScope(user: AuthUser): Prisma.BatchWhereInput {
  switch (user.role) {
    case 'TRAINING_CENTER':
      return { trainingCenterId: user.trainingCenterId ?? '__none__' };
    case 'DISTRICT_OFFICER':
      return { districtId: user.districtId ?? '__none__', status: { not: 'DRAFT' } };
    case 'QUALITY_OFFICER':
      return { requiresQuality: true, status: { notIn: ['DRAFT', 'SUBMITTED', 'DISTRICT_REVIEW'] } };
    case 'STATE_OFFICER':
      return { status: { not: 'DRAFT' } };
    case 'SUPER_ADMIN':
      return {};
    default:
      return { id: '__none__' };
  }
}

export function certificateScope(user: AuthUser): Prisma.CertificateWhereInput {
  if (user.role === 'SUPER_ADMIN') return {};
  return { batch: batchScope(user) };
}

export function deliveryScope(user: AuthUser): Prisma.DeliveryJobWhereInput {
  if (user.role === 'SUPER_ADMIN') return {};
  return { certificate: { batch: batchScope(user) } };
}

/** Whether the caller should see full candidate contact data (only the owning centre). */
export function canSeeCandidateContact(user: AuthUser, batch: { trainingCenterId: string }): boolean {
  return user.role === 'TRAINING_CENTER' && user.trainingCenterId === batch.trainingCenterId;
}
