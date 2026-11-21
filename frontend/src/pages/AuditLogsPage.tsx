import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { Card, EmptyState, ErrorBanner, formatDateTime, PageHeader, Pagination, SkeletonTable } from '../components/ui';
import type { PageMeta } from '../types/api';

interface AuditRow {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  reason: string | null;
  createdAt: string;
  actorRole: string | null;
  actor?: { name: string; email: string; role: string } | null;
}

export function AuditLogsPage() {
  const [search, setSearch] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [page, setPage] = useState(1);

  const q = useQuery({
    queryKey: ['audit-logs', { search, resourceType, page }],
    queryFn: async () => {
      const res = await api.get('/audit-logs', {
        params: { page, pageSize: 20, ...(search ? { search } : {}), ...(resourceType ? { resourceType } : {}) },
      });
      return { items: res.data.data as AuditRow[], meta: res.data.meta as PageMeta };
    },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Immutable Audit Logs"
        subtitle="Append-only record of authentication, approvals, uploads, cancellations, escalations, and configuration changes."
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
              placeholder="Filter by action, actor name, or reason..."
              className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <select
            value={resourceType}
            onChange={(e) => {
              setResourceType(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">All Resources</option>
            <option value="Batch">Batch</option>
            <option value="Certificate">Certificate</option>
            <option value="DeliveryJob">DeliveryJob</option>
            <option value="BatchEscalation">BatchEscalation</option>
            <option value="User">User</option>
            <option value="SystemConfiguration">SystemConfiguration</option>
          </select>
        </div>
      </Card>

      {q.error && <ErrorBanner message={errorMessage(q.error)} />}

      <Card>
        {q.isLoading ? (
          <SkeletonTable rows={8} />
        ) : !q.data || q.data.items.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No audit events match your filter" />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Actor</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Resource</th>
                    <th className="px-4 py-3">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.items.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-slate-500">{formatDateTime(l.createdAt)}</td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900">{l.actor?.name ?? 'System'}</div>
                        <div className="text-[11px] text-slate-400">{l.actorRole ?? 'WORKER'}</div>
                      </td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-navy-900">{l.action}</td>
                      <td className="px-4 py-2.5 text-slate-600">
                        <div>{l.resourceType}</div>
                        {l.resourceId && <div className="font-mono text-[10px] text-slate-400">{l.resourceId.slice(0, 12)}…</div>}
                      </td>
                      <td className="max-w-sm px-4 py-2.5 text-slate-600">{l.reason ?? '—'}</td>
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
