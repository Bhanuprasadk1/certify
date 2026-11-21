import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Download, ExternalLink, Search } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, EmptyState, ErrorBanner, formatDate, Modal, PageHeader, Pagination, SkeletonTable, StatusBadge } from '../components/ui';
import type { PageMeta } from '../types/api';

interface CertRow {
  id: string;
  certificateNumber: string;
  verificationToken: string;
  candidateName: string;
  courseName: string;
  trainingCenterName: string;
  status: string;
  issuedAt: string | null;
  cancelReason: string | null;
  batch: { id: string; code: string; title: string; district: { name: string } };
  deliveryJob?: { id: string; status: string; attempts: number } | null;
}

export function CertificatesPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [cancelTarget, setCancelTarget] = useState<CertRow | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const q = useQuery({
    queryKey: ['certificates', { search, status, page }],
    queryFn: async () => {
      const res = await api.get('/certificates', {
        params: { page, pageSize: 15, ...(search ? { search } : {}), ...(status ? { status } : {}) },
      });
      return { items: res.data.data as CertRow[], meta: res.data.meta as PageMeta };
    },
  });

  const cancelMut = useMutation({
    mutationFn: async () => {
      if (!cancelTarget) return;
      return api.post(`/certificates/${cancelTarget.id}/cancel`, { reason: cancelReason.trim() });
    },
    onSuccess: () => {
      toast.warning('Certificate cancelled — public verification updated immediately');
      setCancelTarget(null);
      setCancelReason('');
      void qc.invalidateQueries({ queryKey: ['certificates'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const downloadPdf = async (cert: CertRow) => {
    try {
      const res = await api.get(`/certificates/${cert.id}/download`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${cert.certificateNumber}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(errorMessage(err, 'Unable to download PDF'));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Certificates"
        subtitle="Download verified PDF certificates, open public verification links, or cancel compromised certificates (State Office)."
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
              placeholder="Search certificate number, candidate name, or course..."
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-teal-600 focus:outline-none"
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
            <option value="">All Statuses</option>
            <option value="ISSUED">Issued</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="PENDING">Pending</option>
          </select>
        </div>
      </Card>

      {q.error && <ErrorBanner message={errorMessage(q.error)} />}

      <Card>
        {q.isLoading ? (
          <SkeletonTable rows={6} />
        ) : !q.data || q.data.items.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No certificates found" description="Certificates appear automatically once a batch receives State approval." />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Certificate No.</th>
                    <th className="px-5 py-3">Candidate &amp; Course</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Delivery</th>
                    <th className="px-5 py-3">Issued</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.items.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3.5">
                        <div className="font-mono text-xs font-semibold text-navy-900">{c.certificateNumber}</div>
                        <Link to={`/batches/${c.batch.id}`} className="text-[11px] text-slate-500 hover:underline">
                          {c.batch.code}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-slate-900">{c.candidateName}</div>
                        <div className="text-xs text-slate-500">{c.courseName}</div>
                        {c.cancelReason && <div className="mt-0.5 text-[11px] text-rose-700">Cancelled: {c.cancelReason}</div>}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={c.status} />
                      </td>
                      <td className="px-5 py-3.5">
                        {c.deliveryJob ? <StatusBadge status={c.deliveryJob.status} /> : <span className="text-xs text-slate-400">—</span>}
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-500">{formatDate(c.issuedAt)}</td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            disabled={c.status !== 'ISSUED'}
                            onClick={() => void downloadPdf(c)}
                            title={c.status === 'CANCELLED' ? 'Cancelled certificates cannot be downloaded' : 'Download PDF'}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                          >
                            <Download className="h-3.5 w-3.5" /> PDF
                          </button>
                          <Link
                            to={`/verify/${c.verificationToken}`}
                            className="inline-flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50/50 px-2.5 py-1.5 text-xs font-medium text-teal-800 hover:bg-teal-50"
                          >
                            <ExternalLink className="h-3.5 w-3.5" /> Verify
                          </Link>
                          {user?.role === 'STATE_OFFICER' && c.status === 'ISSUED' && (
                            <button
                              onClick={() => setCancelTarget(c)}
                              className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
                            >
                              <Ban className="h-3.5 w-3.5" /> Cancel
                            </button>
                          )}
                        </div>
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

      <Modal
        open={!!cancelTarget}
        title="Cancel Issued Certificate"
        onClose={() => {
          setCancelTarget(null);
          setCancelReason('');
        }}
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            Cancelling <strong>{cancelTarget?.certificateNumber}</strong> ({cancelTarget?.candidateName}) immediately marks it as{' '}
            <strong>CANCELLED</strong> on public verification, blocks PDF downloads, and writes an immutable audit record.
          </div>
          <div>
            <label className="block text-xs font-medium uppercase text-slate-600">Mandatory Cancellation Reason</label>
            <textarea
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Explain why this certificate is being revoked (min 5 characters)..."
              className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-rose-500 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setCancelTarget(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium">
              Keep Certificate
            </button>
            <button
              disabled={cancelMut.isPending || cancelReason.trim().length < 5}
              onClick={() => cancelMut.mutate()}
              className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-40"
            >
              {cancelMut.isPending ? 'Cancelling...' : 'Confirm Cancellation'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
