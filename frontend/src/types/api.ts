export type RoleCode =
  | 'TRAINING_CENTER'
  | 'DISTRICT_OFFICER'
  | 'QUALITY_OFFICER'
  | 'STATE_OFFICER'
  | 'SUPER_ADMIN';

export type BatchStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'DISTRICT_REVIEW'
  | 'QUALITY_REVIEW'
  | 'STATE_REVIEW'
  | 'APPROVED'
  | 'CERTIFICATE_PROCESSING'
  | 'CERTIFICATES_ISSUED'
  | 'RETURNED'
  | 'REJECTED'
  | 'CANCELLED';

export type DeliveryStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'RETRYING' | 'FAILED' | 'CANCELLED';
export type CertificateStatus = 'PENDING' | 'ISSUED' | 'CANCELLED' | 'FAILED';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: RoleCode;
  roleName: string;
  district: { id: string; name: string; code: string } | null;
  trainingCenter: { id: string; name: string; code: string } | null;
  lastLoginAt: string | null;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  meta?: PageMeta;
  message?: string;
  errors?: { row?: number; field: string; message: string }[];
}

export interface BatchSummary {
  id: string;
  code: string;
  title: string;
  courseName: string;
  courseCode: string;
  status: BatchStatus;
  version: number;
  candidateCount: number;
  requiresQuality: boolean;
  completionDate: string;
  submittedAt: string | null;
  stageEnteredAt: string;
  returnReason: string | null;
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
  district: { id: string; name: string; code: string };
  trainingCenter: { id: string; name: string; code: string };
  approvals?: { id: string; version: number; stage: string; decision: string; reviewerId: string; reviewer?: { id: string; name: string; role?: RoleCode }; reason?: string | null; createdAt: string }[];
}

export interface RealtimeEvent {
  eventId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  batchId?: string;
  code?: string;
  version?: number;
  status?: string;
  stage?: string;
  decision?: string;
  certificateNumber?: string;
  done?: number;
  total?: number;
  message?: string;
}
