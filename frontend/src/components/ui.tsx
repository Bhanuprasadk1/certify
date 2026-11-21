import React from 'react';
import clsx from 'clsx';
import { AlertCircle, ChevronLeft, ChevronRight, Inbox, X } from 'lucide-react';

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700 border-slate-200',
  SUBMITTED: 'bg-blue-50 text-blue-700 border-blue-200',
  DISTRICT_REVIEW: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  QUALITY_REVIEW: 'bg-amber-50 text-amber-800 border-amber-200',
  STATE_REVIEW: 'bg-violet-50 text-violet-700 border-violet-200',
  APPROVED: 'bg-teal-50 text-teal-800 border-teal-200',
  CERTIFICATE_PROCESSING: 'bg-cyan-50 text-cyan-800 border-cyan-200',
  CERTIFICATES_ISSUED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  RETURNED: 'bg-orange-50 text-orange-800 border-orange-200',
  REJECTED: 'bg-rose-50 text-rose-800 border-rose-200',
  CANCELLED: 'bg-rose-100 text-rose-900 border-rose-300',
  ISSUED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  VALID: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  PENDING: 'bg-slate-100 text-slate-700 border-slate-200',
  PROCESSING: 'bg-sky-50 text-sky-800 border-sky-200',
  SENT: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  RETRYING: 'bg-amber-50 text-amber-800 border-amber-200',
  FAILED: 'bg-rose-50 text-rose-800 border-rose-200',
  OPEN: 'bg-rose-50 text-rose-800 border-rose-200',
  ACKNOWLEDGED: 'bg-amber-50 text-amber-800 border-amber-200',
  RESOLVED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  APPROVE: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  RETURN: 'bg-orange-50 text-orange-800 border-orange-200',
  REJECT: 'bg-rose-50 text-rose-800 border-rose-200',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-tight whitespace-nowrap',
        STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-700 border-slate-200',
        className,
      )}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx('rounded-xl border border-slate-200 bg-white shadow-xs', className)}>{children}</div>;
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'navy',
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  tone?: 'navy' | 'teal' | 'amber' | 'rose' | 'indigo';
}) {
  const iconBg = {
    navy: 'bg-slate-100 text-navy-900',
    teal: 'bg-teal-50 text-teal-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
    indigo: 'bg-indigo-50 text-indigo-700',
  }[tone];

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
          {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
        </div>
        <div className={clsx('rounded-lg p-2.5', iconBg)}>{icon}</div>
      </div>
    </Card>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <Inbox className="h-10 w-10 text-slate-400" />
      <h3 className="mt-3 text-sm font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  onChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onChange: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
      <span className="text-slate-500">
        Page <strong className="text-slate-800">{page}</strong> of {totalPages} ({total} total)
      </span>
      <div className="flex items-center gap-1.5">
        <button
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Prev
        </button>
        <button
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          Next <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-[1px]">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function formatDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
