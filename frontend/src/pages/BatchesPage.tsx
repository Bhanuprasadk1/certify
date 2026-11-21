import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FilePlus2, Search, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, EmptyState, ErrorBanner, formatDate, PageHeader, Pagination, SkeletonTable, StatusBadge } from '../components/ui';
import type { BatchStatus, BatchSummary, PageMeta } from '../types/api';

const STATUSES: BatchStatus[] = [
  'DRAFT',
  'DISTRICT_REVIEW',
  'QUALITY_REVIEW',
  'STATE_REVIEW',
  'APPROVED',
  'CERTIFICATE_PROCESSING',
  'CERTIFICATES_ISSUED',
  'RETURNED',
  'REJECTED',
];

export function BatchesPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const q = useQuery({
    queryKey: ['batches', { search, status, page }],
    queryFn: async () => {
      const res = await api.get('/batches', {
        params: { page, pageSize: 15, ...(search ? { search } : {}), ...(status ? { status } : {}) },
      });
      return { items: res.data.data as BatchSummary[], meta: res.data.meta as PageMeta };
    },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Batch Management"
        subtitle="Track training batches through district, quality, state approval, and certificate issuance."
        actions={
          user?.role === 'TRAINING_CENTER' && (
            <Link
              to="/batches/new"
              className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800"
            >
              <FilePlus2 className="h-4 w-4" /> Create Batch
            </Link>
          )
        }
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
              placeholder="Search by batch code, title, course, or training center..."
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-teal-600 focus:outline-none"
            />
          </div>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-teal-600 focus:outline-none"
          >
            <option value="">All Statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {q.error && <ErrorBanner message={errorMessage(q.error)} />}

      <Card>
        {q.isLoading ? (
          <SkeletonTable rows={6} />
        ) : !q.data || q.data.items.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="No batches found"
              description="Adjust your filters or create a new training batch."
              action={
                user?.role === 'TRAINING_CENTER' && (
                  <Link to="/batches/new" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white">
                    Create Batch
                  </Link>
                )
              }
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Batch &amp; Course</th>
                    <th className="px-5 py-3">Center &amp; District</th>
                    <th className="px-5 py-3">Candidates</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Completion</th>
                    <th className="px-5 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.items.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-3.5">
                        <Link to={`/batches/${b.id}`} className="font-semibold text-navy-900 hover:text-teal-700 hover:underline">
                          {b.title}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono">{b.code}</span>
                          <span>•</span>
                          <span>{b.courseName}</span>
                          <span className="rounded bg-slate-100 px-1.5 py-0.2 text-[10px]">v{b.version}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-600">
                        <div className="font-medium text-slate-800">{b.trainingCenter.name}</div>
                        <div className="text-slate-400">{b.district.name}</div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-1.5 font-semibold text-slate-800">
                          {b.candidateCount}
                          {b.requiresQuality && (
                            <span title="Quality review required (>= threshold)" className="inline-flex items-center text-amber-600">
                              <ShieldCheck className="h-4 w-4" />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={b.status} />
                      </td>
                      <td className="px-5 py-3.5 text-xs text-slate-500">{formatDate(b.completionDate)}</td>
                      <td className="px-5 py-3.5 text-right">
                        <Link
                          to={`/batches/${b.id}`}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Open
                        </Link>
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
