import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RefreshCw, Search } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, EmptyState, ErrorBanner, formatDateTime, PageHeader, Pagination, SkeletonTable, StatusBadge } from '../components/ui';
import type { PageMeta } from '../types/api';

interface DeliveryRow {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  sentAt: string | null;
  recipientMasked: string;
  certificate: {
    id: string;
    certificateNumber: string;
    candidateName: string;
    courseName: string;
    status: string;
    batch: { id: string; code: string };
  };
  attemptLogs: { id: string; attemptNo: number; outcome: string; error: string | null; durationMs: number; createdAt: string }[];
}

export function DeliveriesPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const q = useQuery({
    queryKey: ['deliveries', { status, search, page }],
    queryFn: async () => {
      const res = await api.get('/delivery/jobs', {
        params: { page, pageSize: 15, ...(status ? { status } : {}), ...(search ? { search } : {}) },
      });
      return { items: res.data.data as DeliveryRow[], meta: res.data.meta as PageMeta };
    },
  });

  const retryMut = useMutation({
    mutationFn: async (jobId: string) => api.post(`/delivery/jobs/${jobId}/retry`),
    onSuccess: () => {
      toast.success('Delivery retry queued');
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const canRetry = user?.role === 'STATE_OFFICER' || user?.role === 'SUPER_ADMIN';

  return (
    <div className="space-y-5">
      <PageHeader
        title="WhatsApp Mock Delivery Monitoring"
        subtitle="Asynchronous delivery jobs with exponential backoff retries, attempt history, and idempotent provider keys."
      />

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search candidate or certificate number..."
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">All Delivery Statuses</option>
            <option value="PENDING">Pending</option>
            <option value="PROCESSING">Processing</option>
            <option value="SENT">Sent</option>
            <option value="RETRYING">Retrying</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </Card>

      {q.error && <ErrorBanner message={errorMessage(q.error)} />}

      <Card>
        {q.isLoading ? (
          <SkeletonTable rows={6} />
        ) : !q.data || q.data.items.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No delivery jobs found" description="WhatsApp delivery jobs are queued automatically after PDF generation." />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Candidate &amp; Certificate</th>
                    <th className="px-5 py-3">Recipient</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Attempts</th>
                    <th className="px-5 py-3">Last Error / Next Retry</th>
                    <th className="px-5 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.items.map((j) => (
                    <tr key={j.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3">
                        <div className="font-medium text-slate-900">{j.certificate.candidateName}</div>
                        <div className="font-mono text-xs text-slate-500">{j.certificate.certificateNumber}</div>
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-600">{j.recipientMasked}</td>
                      <td className="px-5 py-3">
                        <StatusBadge status={j.status} />
                      </td>
                      <td className="px-5 py-3 text-xs font-medium text-slate-700">
                        {j.attempts} / {j.maxAttempts}
                      </td>
                      <td className="max-w-xs px-5 py-3 text-xs">
                        {j.status === 'SENT' ? (
                          <span className="text-emerald-700">Delivered {formatDateTime(j.sentAt)}</span>
                        ) : (
                          <div>
                            {j.lastError && <div className="truncate text-rose-700" title={j.lastError}>{j.lastError}</div>}
                            {j.status === 'RETRYING' && (
                              <div className="text-slate-500">Next retry: {formatDateTime(j.nextAttemptAt)}</div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {canRetry && j.status !== 'SENT' && j.status !== 'CANCELLED' && j.certificate.status === 'ISSUED' && (
                          <button
                            onClick={() => retryMut.mutate(j.id)}
                            disabled={retryMut.isPending}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <RefreshCw className="h-3.5 w-3.5" /> Retry Now
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.meta.page} totalPages={q.data.meta.totalPages} total={q.data.meta.total} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
