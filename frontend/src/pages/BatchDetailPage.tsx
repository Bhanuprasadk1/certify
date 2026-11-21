import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import axios from 'axios';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  RotateCcw,
  Send,
  ShieldAlert,
  Upload,
  XCircle,
} from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, ErrorBanner, formatDate, formatDateTime, Modal, PageHeader, SkeletonTable, StatusBadge } from '../components/ui';

interface CandidateRow {
  id: string;
  rowNumber: number;
  externalId: string | null;
  name: string;
  email: string | null;
  phone: string;
  courseName: string;
  completionDate: string;
  certificate?: {
    id: string;
    certificateNumber: string;
    status: string;
    deliveryJob?: { id: string; status: string; attempts: number } | null;
  } | null;
}

interface BatchDetail {
  id: string;
  code: string;
  title: string;
  courseName: string;
  courseCode: string;
  status: string;
  version: number;
  candidateCount: number;
  requiresQuality: boolean;
  completionDate: string;
  returnReason: string | null;
  rejectReason: string | null;
  submittedAt: string | null;
  district: { id: string; name: string };
  trainingCenter: { id: string; name: string };
  candidates: CandidateRow[];
  approvals: {
    id: string;
    version: number;
    stage: string;
    decision: string;
    reason: string | null;
    createdAt: string;
    reviewer: { id: string; name: string; role: string };
  }[];
  auditLogs: {
    id: string;
    action: string;
    reason: string | null;
    createdAt: string;
    actor?: { name: string; role: string } | null;
  }[];
  workflowMeta: {
    requiredDistrictApprovals: number;
    currentDistrictApprovals: number;
    alreadyReviewedByMe: boolean;
  };
}

interface UploadError {
  row?: number;
  field: string;
  message: string;
}

interface PreviewData {
  totalRows: number;
  requiresQuality: boolean;
  candidates: { rowNumber: number; name: string; phone: string; email: string | null; courseName: string; externalId: string | null }[];
}

const STEPS = ['DRAFT', 'DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW', 'CERTIFICATES_ISSUED'];

export function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [uploadErrors, setUploadErrors] = useState<UploadError[]>([]);
  const [uploading, setUploading] = useState(false);

  const [decisionModal, setDecisionModal] = useState<'APPROVE' | 'RETURN' | 'REJECT' | null>(null);
  const [reason, setReason] = useState('');

  const [editModal, setEditModal] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editCourse, setEditCourse] = useState('');

  const q = useQuery({
    queryKey: ['batch', id],
    queryFn: async () => (await api.get(`/batches/${id}`)).data.data as BatchDetail,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['batch', id] });
    void qc.invalidateQueries({ queryKey: ['batches'] });
    void qc.invalidateQueries({ queryKey: ['review-queue'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const handlePreviewOrCommit = async (commit: boolean) => {
    if (!file || !id) return;
    setUploading(true);
    setUploadErrors([]);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post(`/batches/${id}/upload${commit ? '' : '?preview=true'}`, fd);
      if (commit) {
        toast.success(`Atomically uploaded ${res.data.data.uploadedCount} candidates`);
        setPreview(null);
        setFile(null);
        invalidate();
      } else {
        setPreview(res.data.data as PreviewData);
        toast.success(`Validated ${res.data.data.totalRows} rows — ready to confirm upload`);
      }
    } catch (err) {
      if (axios.isAxiosError(err) && Array.isArray(err.response?.data?.errors)) {
        setUploadErrors(err.response.data.errors as UploadError[]);
        setPreview(null);
        toast.error('Validation failed — zero candidates were saved');
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setUploading(false);
    }
  };

  const submitMut = useMutation({
    mutationFn: async (resubmit: boolean) => api.post(`/batches/${id}/${resubmit ? 'resubmit' : 'submit'}`),
    onSuccess: (_, resubmit) => {
      toast.success(resubmit ? 'Batch resubmitted with incremented version' : 'Batch submitted for District Review');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const editMut = useMutation({
    mutationFn: async () => api.put(`/batches/${id}`, { title: editTitle, courseName: editCourse }),
    onSuccess: () => {
      toast.success('Batch details updated');
      setEditModal(false);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const decisionMut = useMutation({
    mutationFn: async (payload: { stage: 'district' | 'quality' | 'state'; decision: string; reason: string }) =>
      api.post(`/batches/${id}/${payload.stage}-decision`, { decision: payload.decision, reason: payload.reason || undefined }),
    onSuccess: (res) => {
      const next = res.data.data.nextStatus;
      toast.success(`Decision recorded (status: ${next})`);
      setDecisionModal(null);
      setReason('');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const stuckMut = useMutation({
    mutationFn: async () => api.post(`/escalations/simulate/${id}`),
    onSuccess: () => {
      toast.warning('Stuck batch simulated and escalation created');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isLoading) return <Card><SkeletonTable rows={8} /></Card>;
  if (q.error || !q.data) return <ErrorBanner message={errorMessage(q.error, 'Batch not found')} />;

  const b = q.data;
  const isOwnerCenter = user?.role === 'TRAINING_CENTER';
  const canEdit = isOwnerCenter && (b.status === 'DRAFT' || b.status === 'RETURNED');
  const activeReviewStage: 'district' | 'quality' | 'state' | null =
    user?.role === 'DISTRICT_OFFICER' && b.status === 'DISTRICT_REVIEW'
      ? 'district'
      : user?.role === 'QUALITY_OFFICER' && b.status === 'QUALITY_REVIEW'
        ? 'quality'
        : user?.role === 'STATE_OFFICER' && b.status === 'STATE_REVIEW'
          ? 'state'
          : null;

  const canSimulateStuck =
    (user?.role === 'STATE_OFFICER' || user?.role === 'SUPER_ADMIN') &&
    ['DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW'].includes(b.status);

  const visibleSteps = b.requiresQuality ? STEPS : STEPS.filter((s) => s !== 'QUALITY_REVIEW');
  const currentStepIndex = Math.max(
    0,
    visibleSteps.findIndex((s) =>
      s === b.status || (s === 'CERTIFICATES_ISSUED' && (b.status === 'APPROVED' || b.status === 'CERTIFICATE_PROCESSING')),
    ),
  );

  return (
    <div className="space-y-6">
      <Link to="/batches" className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-navy-900">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Batches
      </Link>

      <PageHeader
        title={b.title}
        subtitle={`${b.code} • ${b.courseName} (${b.courseCode}) • Version ${b.version} • ${b.trainingCenter.name}, ${b.district.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={b.status} className="px-3 py-1 text-xs" />
            {canEdit && (
              <button
                onClick={() => {
                  setEditTitle(b.title);
                  setEditCourse(b.courseName);
                  setEditModal(true);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Edit Details
              </button>
            )}
            {canEdit && b.candidateCount > 0 && (
              <button
                onClick={() => submitMut.mutate(b.status === 'RETURNED')}
                disabled={submitMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
              >
                {b.status === 'RETURNED' ? <RotateCcw className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                {b.status === 'RETURNED' ? `Resubmit as v${b.version + 1}` : 'Submit Batch'}
              </button>
            )}
            {canSimulateStuck && (
              <button
                onClick={() => stuckMut.mutate()}
                disabled={stuckMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
              >
                <AlertTriangle className="h-3.5 w-3.5" /> Simulate Stuck SLA
              </button>
            )}
          </div>
        }
      />

      {/* Return / Reject alerts */}
      {b.returnReason && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900">
          <div className="font-semibold">Returned for Corrections</div>
          <p className="mt-1">{b.returnReason}</p>
        </div>
      )}
      {b.rejectReason && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">
          <div className="font-semibold">Batch Rejected (Terminal)</div>
          <p className="mt-1">{b.rejectReason}</p>
        </div>
      )}

      {/* Workflow Stepper */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {visibleSteps.map((step, i) => {
            const done = i < currentStepIndex || b.status === 'CERTIFICATES_ISSUED';
            const active = i === currentStepIndex && b.status !== 'RETURNED' && b.status !== 'REJECTED';
            return (
              <div key={step} className="flex flex-1 items-center gap-2">
                <div
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    done ? 'bg-teal-600 text-white' : active ? 'bg-navy-900 text-white' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {i + 1}
                </div>
                <div className="text-xs">
                  <div className={`font-semibold ${active || done ? 'text-slate-900' : 'text-slate-400'}`}>
                    {step.replace(/_/g, ' ')}
                  </div>
                  {step === 'DISTRICT_REVIEW' && (
                    <div className="text-[11px] text-slate-500">
                      {b.workflowMeta.currentDistrictApprovals}/{b.workflowMeta.requiredDistrictApprovals} approvals (v{b.version})
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Active Officer Review Bar */}
      {activeReviewStage && (
        <Card className="border-teal-200 bg-teal-50/40 p-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h3 className="text-sm font-semibold text-navy-900">
                {activeReviewStage.toUpperCase()} Review Action Required (Batch v{b.version})
              </h3>
              <p className="mt-0.5 text-xs text-slate-600">
                {b.workflowMeta.alreadyReviewedByMe
                  ? 'You have already recorded your decision for this batch version.'
                  : 'Inspect the candidate list and approval history below before recording your decision.'}
              </p>
            </div>
            {!b.workflowMeta.alreadyReviewedByMe && (
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setDecisionModal('APPROVE')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  <CheckCircle2 className="h-4 w-4" /> Approve
                </button>
                <button
                  onClick={() => setDecisionModal('RETURN')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-700"
                >
                  <RotateCcw className="h-4 w-4" /> Return
                </button>
                <button
                  onClick={() => setDecisionModal('REJECT')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
                >
                  <XCircle className="h-4 w-4" /> Reject
                </button>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Atomic CSV/Excel Candidate Uploader (DRAFT / RETURNED only) */}
      {canEdit && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <FileSpreadsheet className="h-4 w-4 text-teal-600" /> Atomic Candidate CSV / Excel Upload
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Columns: <code className="rounded bg-slate-100 px-1">name, email, phone, course, completion_date, candidate_id</code>.
                If any row fails validation, zero rows are saved.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="file"
              accept=".csv,.xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setUploadErrors([]);
              }}
              className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-200"
            />
            <div className="flex shrink-0 gap-2">
              <button
                disabled={!file || uploading}
                onClick={() => void handlePreviewOrCommit(false)}
                className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                Validate &amp; Preview
              </button>
              <button
                disabled={!file || uploading}
                onClick={() => void handlePreviewOrCommit(true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-4 py-2 text-xs font-semibold text-white hover:bg-navy-800 disabled:opacity-40"
              >
                <Upload className="h-3.5 w-3.5" /> {uploading ? 'Processing...' : 'Confirm Atomic Upload'}
              </button>
            </div>
          </div>

          {/* Detailed Row Validation Errors */}
          {uploadErrors.length > 0 && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
                <ShieldAlert className="h-4 w-4" /> Candidate Validation Failed ({uploadErrors.length} errors) — Zero Records Saved
              </div>
              <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-rose-200 bg-white">
                <table className="w-full text-left text-xs">
                  <thead className="bg-rose-50 text-rose-800">
                    <tr>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Field</th>
                      <th className="px-3 py-2">Error Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rose-100">
                    {uploadErrors.map((er, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-1.5 font-mono font-semibold text-rose-700">{er.row ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono text-slate-700">{er.field}</td>
                        <td className="px-3 py-1.5 text-slate-700">{er.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Valid Preview */}
          {preview && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold text-emerald-900">
                  All {preview.totalRows} candidate rows passed validation
                  {preview.requiresQuality && ' • Quality Review will be required (>= threshold)'}
                </div>
                <button
                  onClick={() => void handlePreviewOrCommit(true)}
                  className="rounded-lg bg-emerald-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                >
                  Save {preview.totalRows} Candidates
                </button>
              </div>
              <div className="mt-3 max-h-48 overflow-y-auto rounded-lg border border-emerald-200 bg-white">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Phone</th>
                      <th className="px-3 py-2">Email</th>
                      <th className="px-3 py-2">Candidate ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.candidates.slice(0, 15).map((c) => (
                      <tr key={c.rowNumber}>
                        <td className="px-3 py-1.5 font-mono">{c.rowNumber}</td>
                        <td className="px-3 py-1.5 font-medium">{c.name}</td>
                        <td className="px-3 py-1.5 font-mono">{c.phone}</td>
                        <td className="px-3 py-1.5">{c.email ?? '—'}</td>
                        <td className="px-3 py-1.5 font-mono">{c.externalId ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Candidates Table */}
      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-900">Candidates ({b.candidates.length})</h3>
          <span className="text-xs text-slate-500">Completion: {formatDate(b.completionDate)}</span>
        </div>
        {b.candidates.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">No candidates uploaded yet.</p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">#</th>
                  <th className="px-4 py-2.5">Candidate</th>
                  <th className="px-4 py-2.5">Phone</th>
                  <th className="px-4 py-2.5">Course</th>
                  <th className="px-4 py-2.5">Certificate</th>
                  <th className="px-4 py-2.5">Delivery</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {b.candidates.map((c, idx) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-mono text-slate-400">{idx + 1}</td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{c.name}</div>
                      <div className="text-[11px] text-slate-500">{c.externalId || c.email || '—'}</div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-600">{c.phone}</td>
                    <td className="px-4 py-2.5 text-slate-600">{c.courseName}</td>
                    <td className="px-4 py-2.5">
                      {c.certificate ? (
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={c.certificate.status} />
                          <span className="font-mono text-[11px] text-slate-500">{c.certificate.certificateNumber}</span>
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {c.certificate?.deliveryJob ? <StatusBadge status={c.certificate.deliveryJob.status} /> : <span className="text-slate-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Approval History & Audit Trail */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Approval &amp; Version History</h3>
          {b.approvals.length === 0 ? (
            <p className="mt-4 text-xs text-slate-500">No review decisions recorded yet.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {b.approvals.map((a) => (
                <div key={a.id} className="rounded-lg border border-slate-200 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={a.decision} />
                      <span className="font-semibold text-slate-900">{a.stage}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">v{a.version}</span>
                      {a.version < b.version && <span className="text-[10px] text-slate-400">(Historical)</span>}
                    </div>
                    <span className="text-slate-400">{formatDateTime(a.createdAt)}</span>
                  </div>
                  <div className="mt-1.5 text-slate-600">
                    Reviewer: <strong>{a.reviewer.name}</strong> ({a.reviewer.role.replace(/_/g, ' ')})
                  </div>
                  {a.reason && <p className="mt-1 rounded bg-slate-50 p-2 text-slate-700">{a.reason}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Batch Audit Trail</h3>
          <div className="mt-4 max-h-80 space-y-2.5 overflow-y-auto">
            {b.auditLogs.map((l) => (
              <div key={l.id} className="flex items-start gap-2.5 border-b border-slate-100 pb-2.5 text-xs">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-medium text-slate-800">{l.action}</span>
                    <span className="text-[11px] text-slate-400">{formatDateTime(l.createdAt)}</span>
                  </div>
                  <div className="text-slate-500">{l.actor ? `${l.actor.name} (${l.actor.role})` : 'System Worker'}</div>
                  {l.reason && <div className="mt-0.5 text-slate-600">{l.reason}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Review Decision Modal */}
      <Modal
        open={!!decisionModal && !!activeReviewStage}
        title={`${decisionModal} Batch (${activeReviewStage?.toUpperCase()} Review)`}
        onClose={() => {
          setDecisionModal(null);
          setReason('');
        }}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {decisionModal === 'APPROVE'
              ? `Confirm approval of batch ${b.code} (v${b.version}).`
              : `A mandatory reason is required to ${decisionModal?.toLowerCase()} batch ${b.code}.`}
          </p>
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">
              {decisionModal === 'APPROVE' ? 'Remarks (Optional)' : 'Reason (Required, min 5 chars)'}
            </label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Enter review remarks..."
              className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-teal-600 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDecisionModal(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium">
              Cancel
            </button>
            <button
              disabled={decisionMut.isPending || (decisionModal !== 'APPROVE' && reason.trim().length < 5)}
              onClick={() =>
                activeReviewStage &&
                decisionModal &&
                decisionMut.mutate({ stage: activeReviewStage, decision: decisionModal, reason })
              }
              className="rounded-lg bg-navy-900 px-4 py-2 text-xs font-semibold text-white hover:bg-navy-800 disabled:opacity-40"
            >
              {decisionMut.isPending ? 'Recording...' : `Confirm ${decisionModal}`}
            </button>
          </div>
        </div>
      </Modal>

      {/* Edit Batch Modal */}
      <Modal open={editModal} title="Edit Batch Details" onClose={() => setEditModal(false)}>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">Batch Title</label>
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">Course Name</label>
            <input
              value={editCourse}
              onChange={(e) => setEditCourse(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditModal(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium">
              Cancel
            </button>
            <button
              disabled={editMut.isPending}
              onClick={() => editMut.mutate()}
              className="rounded-lg bg-navy-900 px-4 py-2 text-xs font-semibold text-white"
            >
              Save Changes
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
