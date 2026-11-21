import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, EmptyState, ErrorBanner, formatDateTime, Modal, PageHeader, SkeletonTable, StatusBadge } from '../components/ui';

interface EscalationRow {
  id: string;
  stage: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  responsibleRole: string;
  elapsedMinutes: number;
  slaMinutes: number;
  message: string;
  resolution: string | null;
  createdAt: string;
  batch: { id: string; code: string; title: string; status: string; district: { name: string }; trainingCenter: { name: string } };
}

export function EscalationsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [resolveTarget, setResolveTarget] = useState<EscalationRow | null>(null);
  const [resolution, setResolution] = useState('');

  const q = useQuery({
    queryKey: ['escalations'],
    queryFn: async () => (await api.get('/escalations')).data.data as EscalationRow[],
  });

  const scanMut = useMutation({
    mutationFn: async () => (await api.post('/escalations/scan')).data.data as { scanned: number; created: number },
    onSuccess: (d) => {
      toast.success(`SLA scan complete: ${d.scanned} overdue batches checked, ${d.created} new escalations`);
      void qc.invalidateQueries({ queryKey: ['escalations'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const updateMut = useMutation({
    mutationFn: async (p: { id: string; status: 'ACKNOWLEDGED' | 'RESOLVED'; resolution?: string }) =>
      api.patch(`/escalations/${p.id}`, { status: p.status, resolution: p.resolution }),
    onSuccess: () => {
      toast.success('Escalation updated');
      setResolveTarget(null);
      setResolution('');
      void qc.invalidateQueries({ queryKey: ['escalations'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const canManage = user?.role === 'STATE_OFFICER' || user?.role === 'SUPER_ADMIN';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stuck Batch Escalations"
        subtitle="Batches exceeding configured stage SLAs are escalated once per stage version and surfaced to State Officers."
        actions={
          canManage && (
            <button
              onClick={() => scanMut.mutate()}
              disabled={scanMut.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-navy-900 px-4 py-2 text-xs font-semibold text-white hover:bg-navy-800"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Run SLA Scan Now
            </button>
          )
        }
      />

      {q.error && <ErrorBanner message={errorMessage(q.error)} />}

      <Card>
        {q.isLoading ? (
          <SkeletonTable rows={5} />
        ) : !q.data || q.data.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="No escalations recorded"
              description="Open any pending batch and click 'Simulate Stuck SLA' (as State Officer or Admin) to test escalation."
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {q.data.map((e) => (
              <div key={e.id} className="flex flex-col justify-between gap-4 p-5 lg:flex-row lg:items-center">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <AlertTriangle className={`h-4 w-4 ${e.status === 'RESOLVED' ? 'text-emerald-600' : 'text-rose-600'}`} />
                    <Link to={`/batches/${e.batch.id}`} className="font-semibold text-navy-900 hover:underline">
                      {e.batch.title} ({e.batch.code})
                    </Link>
                    <StatusBadge status={e.status} />
                    <StatusBadge status={e.stage} />
                  </div>
                  <p className="text-xs text-slate-600">{e.message}</p>
                  <div className="text-xs text-slate-500">
                    Responsible: <strong>{e.responsibleRole.replace(/_/g, ' ')}</strong> • Elapsed:{' '}
                    <strong className="text-rose-700">{e.elapsedMinutes}m</strong> (SLA: {e.slaMinutes}m) • Created:{' '}
                    {formatDateTime(e.createdAt)}
                  </div>
                  {e.resolution && <div className="text-xs text-emerald-700">Resolution: {e.resolution}</div>}
                </div>

                {canManage && e.status !== 'RESOLVED' && (
                  <div className="flex items-center gap-2">
                    {e.status === 'OPEN' && (
                      <button
                        onClick={() => updateMut.mutate({ id: e.id, status: 'ACKNOWLEDGED' })}
                        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                      >
                        Acknowledge
                      </button>
                    )}
                    <button
                      onClick={() => setResolveTarget(e)}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" /> Resolve
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={!!resolveTarget} title="Resolve Escalation" onClose={() => setResolveTarget(null)}>
        <div className="space-y-4">
          <textarea
            rows={3}
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            placeholder="Resolution note (e.g., Followed up with district officer)..."
            className="w-full rounded-lg border border-slate-300 p-2.5 text-sm"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setResolveTarget(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-xs">
              Cancel
            </button>
            <button
              onClick={() => resolveTarget && updateMut.mutate({ id: resolveTarget.id, status: 'RESOLVED', resolution })}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white"
            >
              Mark Resolved
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
