import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Eye, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, EmptyState, ErrorBanner, formatDateTime, Modal, PageHeader, Pagination, SkeletonTable, StatusBadge } from '../components/ui';
import type { BatchSummary, PageMeta } from '../types/api';

type Stage = 'district' | 'quality' | 'state';

const STAGE_META: Record<Stage, { title: string; subtitle: string; endpoint: string; decisionRole: string; stageKey: string }> = {
  district: {
    title: 'District Review Queue',
    subtitle: 'Requires 2 distinct District Officer approvals before advancing to Quality or State Review.',
    endpoint: '/district/batches/pending',
    decisionRole: 'DISTRICT_OFFICER',
    stageKey: 'DISTRICT',
  },
  quality: {
    title: 'Quality Assurance Queue',
    subtitle: 'Mandatory inspection queue for large cohorts meeting or exceeding the candidate threshold.',
    endpoint: '/quality/batches/pending',
    decisionRole: 'QUALITY_OFFICER',
    stageKey: 'QUALITY',
  },
  state: {
    title: 'State Final Approval Queue',
    subtitle: 'Final authority approval. Approving here triggers asynchronous PDF generation & WhatsApp delivery.',
    endpoint: '/state/batches/pending',
    decisionRole: 'STATE_OFFICER',
    stageKey: 'STATE',
  },
};

export function ReviewQueuePage({ stage }: { stage: Stage }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const meta = STAGE_META[stage];
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ batch: BatchSummary; decision: 'APPROVE' | 'RETURN' | 'REJECT' } | null>(null);
  const [reason, setReason] = useState('');

  const q = useQuery({
    queryKey: ['review-queue', stage, page],
    queryFn: async () => {
      const res = await api.get(meta.endpoint, { params: { page, pageSize: 15 } });
      return { items: res.data.data as BatchSummary[], meta: res.data.meta as PageMeta };
    },
  });

  const decisionMut = useMutation({
    mutationFn: async () => {
      if (!selected) return;
      return api.post(`/batches/${selected.batch.id}/${stage}-decision`, {
        decision: selected.decision,
        reason: reason.trim() || undefined,
      });
    },
    onSuccess: (res) => {
      toast.success(`Decision saved → ${res?.data?.data?.nextStatus ?? 'updated'}`);
      setSelected(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['review-queue'] });
      void qc.invalidateQueries({ queryKey: ['batches'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const canAct = user?.role === meta.decisionRole;

  return (
    <div className="space-y-5">
      <PageHeader title={meta.title} subtitle={meta.subtitle} />

      {q.error && <ErrorBanner message={errorMessage(q.error)} />}

      <Card>
        {q.isLoading ? (
          <SkeletonTable rows={5} />
        ) : !q.data || q.data.items.length === 0 ? (
          <div className="p-6">
            <EmptyState title="Queue is clear" description={`No batches are currently awaiting ${stage} review.`} />
          </div>
        ) : (
          <>
            <div className="divide-y divide-slate-200">
              {q.data.items.map((b) => {
                const currentApprovals = (b.approvals ?? []).filter((a) => a.version === b.version && a.decision === 'APPROVE');
                const districtCount = currentApprovals.filter((a) => a.stage === 'DISTRICT').length;
                const qualityDone = currentApprovals.some((a) => a.stage === 'QUALITY');
                const alreadyMine = (b.approvals ?? []).some(
                  (a) => a.version === b.version && a.stage === meta.stageKey && a.reviewerId === user?.id,
                );

                return (
                  <div key={b.id} className="flex flex-col justify-between gap-4 p-5 lg:flex-row lg:items-center">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/batches/${b.id}`} className="text-base font-semibold text-navy-900 hover:text-teal-700 hover:underline">
                          {b.title}
                        </Link>
                        <StatusBadge status={b.status} />
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">v{b.version}</span>
                        {b.requiresQuality && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            <ShieldCheck className="h-3 w-3" /> Quality Required
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-600">
                        <span className="font-mono">{b.code}</span> • {b.courseName} • <strong>{b.candidateCount} candidates</strong>
                      </div>
                      <div className="text-xs text-slate-500">
                        {b.trainingCenter.name} ({b.district.name}) • Entered stage: {formatDateTime(b.stageEnteredAt)}
                      </div>
                      <div className="flex flex-wrap gap-2 pt-1 text-[11px]">
                        <span className="rounded bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700">
                          District Approvals: {districtCount}/2
                        </span>
                        {b.requiresQuality && (
                          <span
                            className={`rounded px-2 py-0.5 font-medium ${
                              qualityDone ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            Quality Review: {qualityDone ? 'Approved' : 'Pending'}
                          </span>
                        )}
                        {alreadyMine && (
                          <span className="rounded bg-teal-50 px-2 py-0.5 font-medium text-teal-800">You already approved v{b.version}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/batches/${b.id}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <Eye className="h-3.5 w-3.5" /> Inspect
                      </Link>
                      {canAct && !alreadyMine && (
                        <>
                          <button
                            onClick={() => setSelected({ batch: b, decision: 'APPROVE' })}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => setSelected({ batch: b, decision: 'RETURN' })}
                            className="inline-flex items-center gap-1 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Return
                          </button>
                          <button
                            onClick={() => setSelected({ batch: b, decision: 'REJECT' })}
                            className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                          >
                            <XCircle className="h-3.5 w-3.5" /> Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onChange={setPage} />
          </>
        )}
      </Card>

      <Modal
        open={!!selected}
        title={`${selected?.decision ?? ''} — ${selected?.batch.code ?? ''}`}
        onClose={() => {
          setSelected(null);
          setReason('');
        }}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {selected?.decision === 'APPROVE'
              ? `Record your ${stage} approval for "${selected.batch.title}" (v${selected.batch.version})?`
              : `Enter a mandatory reason to ${selected?.decision.toLowerCase()} this batch.`}
          </p>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={selected?.decision === 'APPROVE' ? 'Optional verification remarks...' : 'Mandatory reason (min 5 characters)...'}
            className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-teal-600 focus:outline-none"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setSelected(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium">
              Cancel
            </button>
            <button
              disabled={decisionMut.isPending || (selected?.decision !== 'APPROVE' && reason.trim().length < 5)}
              onClick={() => decisionMut.mutate()}
              className="rounded-lg bg-navy-900 px-4 py-2 text-xs font-semibold text-white hover:bg-navy-800 disabled:opacity-40"
            >
              {decisionMut.isPending ? 'Saving...' : 'Confirm Decision'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
