import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, Database, RotateCcw, Save, Server, Users } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Card, ErrorBanner, formatDateTime, PageHeader, SkeletonTable, StatusBadge } from '../components/ui';

interface ConfigItem {
  key: string;
  value: unknown;
  description: string;
}

interface HealthData {
  database: string;
  redis: string;
  broker: { driver: string; connected: boolean; queues: { queue: string; messages: number; consumers: number }[] };
  workers: { name: string; status: string; lastBeatAt: string }[];
  outbox: Record<string, number>;
  delivery: Record<string, number>;
}

export function AdminPage() {
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === 'SUPER_ADMIN';

  const healthQ = useQuery({
    queryKey: ['admin-health'],
    queryFn: async () => (await api.get('/admin/health')).data.data as HealthData,
    refetchInterval: 10_000,
  });

  const configQ = useQuery({
    queryKey: ['admin-config'],
    queryFn: async () => (await api.get('/admin/config')).data.data as ConfigItem[],
  });

  const usersQ = useQuery({
    queryKey: ['admin-users'],
    enabled: isAdmin,
    queryFn: async () =>
      (await api.get('/admin/users')).data.data as {
        users: { id: string; name: string; email: string; role: string; isActive: boolean; district?: { name: string } | null; trainingCenter?: { name: string } | null }[];
      },
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const saveCfg = useMutation({
    mutationFn: async ({ key, raw }: { key: string; raw: string }) => {
      const parsed = JSON.parse(raw);
      return api.put(`/admin/config/${encodeURIComponent(key)}`, { value: parsed });
    },
    onSuccess: (_, vars) => {
      toast.success(`Saved configuration: ${vars.key}`);
      void qc.invalidateQueries({ queryKey: ['admin-config'] });
    },
    onError: (e) => toast.error(errorMessage(e, 'Invalid JSON or value')),
  });

  const resetDemo = useMutation({
    mutationFn: async () => api.post('/admin/demo/reset'),
    onSuccess: async () => {
      toast.success('Demo database reset to clean initial state. Please sign in again.');
      await logout();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="System Administration & Health"
        subtitle="Inspect infrastructure health, queue depth, worker heartbeats, configurable thresholds, and demo controls."
        actions={
          isAdmin && (
            <button
              onClick={() => {
                if (window.confirm('Reset all demo batches, certificates, and logs back to initial seed state?')) {
                  resetDemo.mutate();
                }
              }}
              disabled={resetDemo.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100"
            >
              <RotateCcw className="h-3.5 w-3.5" /> {resetDemo.isPending ? 'Resetting...' : 'Reset Demo Data'}
            </button>
          )
        }
      />

      {/* Infrastructure Health */}
      {healthQ.error && <ErrorBanner message={errorMessage(healthQ.error)} />}
      {healthQ.data && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
                <Database className="h-4 w-4 text-teal-600" /> PostgreSQL
              </div>
              <StatusBadge status={healthQ.data.database === 'up' ? 'VALID' : 'FAILED'} />
            </div>
            <p className="mt-2 text-xs text-slate-500">Authoritative relational store &amp; transactional outbox</p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
                <Server className="h-4 w-4 text-teal-600" /> Message Broker ({healthQ.data.broker.driver})
              </div>
              <StatusBadge status={healthQ.data.broker.connected ? 'VALID' : 'FAILED'} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Outbox: {healthQ.data.outbox.PUBLISHED ?? 0} published • {healthQ.data.outbox.PENDING ?? 0} pending •{' '}
              {healthQ.data.outbox.FAILED ?? 0} failed
            </p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
                <Activity className="h-4 w-4 text-teal-600" /> Redis &amp; Workers
              </div>
              <StatusBadge status={healthQ.data.redis === 'up' ? 'VALID' : 'PENDING'} />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Redis: {healthQ.data.redis} • Active workers: {healthQ.data.workers.filter((w) => w.status === 'running').length}
            </p>
          </Card>
        </div>
      )}

      {/* Workers & Queues */}
      {healthQ.data && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">Background Workers</h3>
            <div className="mt-3 divide-y divide-slate-100 text-xs">
              {healthQ.data.workers.length === 0 ? (
                <p className="py-4 text-slate-500">No worker heartbeats recorded yet.</p>
              ) : (
                healthQ.data.workers.map((w) => (
                  <div key={w.name} className="flex items-center justify-between py-2.5">
                    <span className="font-mono font-medium text-slate-800">{w.name}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-slate-400">{formatDateTime(w.lastBeatAt)}</span>
                      <StatusBadge status={w.status === 'running' ? 'VALID' : 'FAILED'} />
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="text-sm font-semibold text-slate-900">Queue Depth &amp; Dead-Letter Queues</h3>
            <div className="mt-3 divide-y divide-slate-100 text-xs">
              {healthQ.data.broker.queues.length === 0 ? (
                <p className="py-4 text-slate-500">No queues active.</p>
              ) : (
                healthQ.data.broker.queues.map((q) => (
                  <div key={q.queue} className="flex items-center justify-between py-2.5">
                    <span className="font-mono text-slate-700">{q.queue}</span>
                    <span className="text-slate-500">
                      Messages: <strong className="text-slate-900">{q.messages < 0 ? '—' : q.messages}</strong> • Consumers:{' '}
                      <strong>{q.consumers}</strong>
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      )}

      {/* System Configuration */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-slate-900">Workflow, SLA &amp; Mock Delivery Configuration</h3>
        <p className="mt-1 text-xs text-slate-500">Changes take effect immediately across API and background workers.</p>
        {configQ.isLoading ? (
          <SkeletonTable rows={4} />
        ) : (
          <div className="mt-4 space-y-4">
            {configQ.data?.map((c) => {
              const current = drafts[c.key] ?? JSON.stringify(c.value);
              return (
                <div key={c.key} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                    <div>
                      <div className="font-mono text-xs font-semibold text-navy-900">{c.key}</div>
                      <div className="text-xs text-slate-500">{c.description}</div>
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => saveCfg.mutate({ key: c.key, raw: current })}
                        disabled={saveCfg.isPending}
                        className="inline-flex items-center gap-1 self-start rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
                      >
                        <Save className="h-3.5 w-3.5" /> Save
                      </button>
                    )}
                  </div>
                  <input
                    disabled={!isAdmin}
                    value={current}
                    onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                    className="mt-2.5 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs focus:bg-white focus:outline-none"
                  />
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Users Directory (Super Admin) */}
      {isAdmin && usersQ.data && (
        <Card className="p-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Users className="h-4 w-4 text-teal-600" /> Registered Platform Users ({usersQ.data.users.length})
          </h3>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Email</th>
                  <th className="px-4 py-2.5">Role</th>
                  <th className="px-4 py-2.5">Assignment</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {usersQ.data.users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2.5 font-medium text-slate-900">{u.name}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-600">{u.email}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={u.role} />
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {u.trainingCenter?.name || (u.district ? `${u.district.name} District` : 'State / Global')}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={u.isActive ? 'VALID' : 'CANCELLED'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
