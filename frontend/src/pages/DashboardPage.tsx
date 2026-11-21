import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Award, CheckCircle2, Clock, FilePlus2, Layers, MessageSquare, Users } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, ErrorBanner, formatDate, PageHeader, SkeletonTable, StatCard, StatusBadge } from '../components/ui';
import type { BatchSummary } from '../types/api';

interface DashboardData {
  metrics: {
    totalBatches: number;
    draftBatches: number;
    pendingBatches: number;
    districtReview: number;
    qualityReview: number;
    stateReview: number;
    approvedBatches: number;
    returnedBatches: number;
    rejectedBatches: number;
    totalCandidates: number;
    certificatesIssued: number;
    certificatesCancelled: number;
    certificatesPending: number;
    deliveriesSent: number;
    deliveriesRetrying: number;
    deliveriesFailed: number;
    deliveriesPending: number;
    openEscalations: number;
  };
  charts: {
    batchesByStatus: { status: string; count: number }[];
    deliveryByStatus: { status: string; count: number }[];
    batchesByDistrict: { district: string; batches: number; candidates: number }[];
  };
  recentBatches: BatchSummary[];
}

const PIE_COLORS = ['#0d7a6f', '#f59e0b', '#e11d48', '#3b82f6', '#64748b'];

export function DashboardPage() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => (await api.get('/dashboard/summary')).data.data as DashboardData,
  });

  if (q.isLoading) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Loading live metrics..." />
        <Card>
          <SkeletonTable rows={6} />
        </Card>
      </div>
    );
  }
  if (q.error || !q.data) {
    return <ErrorBanner message={errorMessage(q.error, 'Failed to load dashboard')} />;
  }

  const m = q.data.metrics;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome, ${user?.name}`}
        subtitle={`${user?.roleName}${user?.trainingCenter ? ` • ${user.trainingCenter.name}` : user?.district ? ` • ${user.district.name} District` : ''}`}
        actions={
          <>
            {user?.role === 'TRAINING_CENTER' && (
              <Link
                to="/batches/new"
                className="inline-flex items-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800"
              >
                <FilePlus2 className="h-4 w-4" /> Create Batch
              </Link>
            )}
            {user?.role === 'DISTRICT_OFFICER' && (
              <Link to="/reviews/district" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800">
                Open District Queue ({m.districtReview})
              </Link>
            )}
            {user?.role === 'QUALITY_OFFICER' && (
              <Link to="/reviews/quality" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800">
                Open Quality Queue ({m.qualityReview})
              </Link>
            )}
            {user?.role === 'STATE_OFFICER' && (
              <Link to="/reviews/state" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800">
                Open State Queue ({m.stateReview})
              </Link>
            )}
          </>
        }
      />

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Batches"
          value={m.totalBatches}
          sub={`${m.approvedBatches} approved • ${m.returnedBatches} returned`}
          icon={<Layers className="h-5 w-5" />}
          tone="navy"
        />
        <StatCard
          label="Pending Review"
          value={m.pendingBatches}
          sub={`D:${m.districtReview} • Q:${m.qualityReview} • S:${m.stateReview}`}
          icon={<Clock className="h-5 w-5" />}
          tone="indigo"
        />
        <StatCard
          label="Certificates Issued"
          value={m.certificatesIssued}
          sub={`${m.certificatesCancelled} cancelled • ${m.totalCandidates} total candidates`}
          icon={<Award className="h-5 w-5" />}
          tone="teal"
        />
        <StatCard
          label="Open Escalations"
          value={m.openEscalations}
          sub={`${m.deliveriesSent} WA sent • ${m.deliveriesRetrying + m.deliveriesFailed} retrying/failed`}
          icon={m.openEscalations > 0 ? <AlertTriangle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
          tone={m.openEscalations > 0 ? 'rose' : 'teal'}
        />
      </div>

      {/* Secondary Metrics Strip */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Users className="h-4 w-4 text-slate-400" /> Candidates in Scope
          </div>
          <div className="mt-1 text-xl font-bold text-slate-900">{m.totalCandidates}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <MessageSquare className="h-4 w-4 text-emerald-600" /> WhatsApp Sent
          </div>
          <div className="mt-1 text-xl font-bold text-emerald-700">{m.deliveriesSent}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Clock className="h-4 w-4 text-amber-600" /> Delivery Retrying
          </div>
          <div className="mt-1 text-xl font-bold text-amber-700">{m.deliveriesRetrying}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <AlertTriangle className="h-4 w-4 text-rose-600" /> Rejected / Cancelled
          </div>
          <div className="mt-1 text-xl font-bold text-rose-700">
            {m.rejectedBatches} / {m.certificatesCancelled}
          </div>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">Batches by Workflow Stage</h3>
          <div className="mt-4 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={q.data.charts.batchesByStatus.map((d) => ({ ...d, label: d.status.replace(/_/g, ' ') }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#0f2744" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold text-slate-900">WhatsApp Delivery Distribution</h3>
          <div className="mt-4 h-64">
            {q.data.charts.deliveryByStatus.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">No delivery jobs yet</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={q.data.charts.deliveryByStatus}
                    dataKey="count"
                    nameKey="status"
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={88}
                    paddingAngle={3}
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {q.data.charts.deliveryByStatus.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
      </div>

      {/* Recent Batches */}
      <Card>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-sm font-semibold text-slate-900">Recent Batches</h3>
          <Link to="/batches" className="text-xs font-medium text-teal-700 hover:underline">
            View all →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-5 py-3">Batch</th>
                <th className="px-5 py-3">Center / District</th>
                <th className="px-5 py-3">Candidates</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {q.data.recentBatches.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50/70">
                  <td className="px-5 py-3">
                    <Link to={`/batches/${b.id}`} className="font-medium text-navy-900 hover:text-teal-700 hover:underline">
                      {b.title}
                    </Link>
                    <div className="font-mono text-xs text-slate-500">
                      {b.code} • v{b.version}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-600">
                    <div>{b.trainingCenter.name}</div>
                    <div className="text-slate-400">{b.district.name}</div>
                  </td>
                  <td className="px-5 py-3 font-medium text-slate-800">{b.candidateCount}</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-500">{formatDate(b.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
