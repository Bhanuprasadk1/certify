import React, { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  AlertTriangle,
  Award,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  FilePlus2,
  FileSearch,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  ScrollText,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { RoleCode } from '../types/api';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  roles?: RoleCode[];
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { to: '/batches', label: 'Batches', icon: <Layers className="h-4 w-4" /> },
  { to: '/batches/new', label: 'Create Batch', icon: <FilePlus2 className="h-4 w-4" />, roles: ['TRAINING_CENTER'] },
  { to: '/reviews/district', label: 'District Review', icon: <ClipboardCheck className="h-4 w-4" />, roles: ['DISTRICT_OFFICER', 'SUPER_ADMIN'] },
  { to: '/reviews/quality', label: 'Quality Review', icon: <ShieldCheck className="h-4 w-4" />, roles: ['QUALITY_OFFICER', 'SUPER_ADMIN'] },
  { to: '/reviews/state', label: 'State Approval', icon: <CheckCircle2 className="h-4 w-4" />, roles: ['STATE_OFFICER', 'SUPER_ADMIN'] },
  { to: '/certificates', label: 'Certificates', icon: <Award className="h-4 w-4" /> },
  { to: '/deliveries', label: 'WhatsApp Delivery', icon: <MessageSquare className="h-4 w-4" /> },
  {
    to: '/escalations',
    label: 'Escalations',
    icon: <AlertTriangle className="h-4 w-4" />,
    roles: ['STATE_OFFICER', 'SUPER_ADMIN', 'DISTRICT_OFFICER', 'QUALITY_OFFICER'],
  },
  { to: '/audit-logs', label: 'Audit Logs', icon: <ScrollText className="h-4 w-4" />, roles: ['STATE_OFFICER', 'SUPER_ADMIN'] },
  { to: '/admin', label: 'Admin & Health', icon: <Settings className="h-4 w-4" />, roles: ['SUPER_ADMIN', 'STATE_OFFICER'] },
  { to: '/verify', label: 'Public Verification', icon: <FileSearch className="h-4 w-4" /> },
];

export function Layout() {
  const { user, logout, notifications, clearNotifications } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const navigate = useNavigate();

  if (!user) return null;

  const visibleNav = NAV_ITEMS.filter((i) => !i.roles || i.roles.includes(user.role));

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-navy-900 text-slate-100 transition-transform lg:static lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-white/10 px-5">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 font-bold text-white">CF</div>
            <div>
              <div className="text-sm font-bold tracking-tight text-white">CertiFlow</div>
              <div className="text-[11px] text-teal-300">Pragati Skills Mission</div>
            </div>
          </Link>
          <button onClick={() => setSidebarOpen(false)} className="rounded p-1 text-slate-300 lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'bg-teal-600 text-white shadow-xs' : 'text-slate-300 hover:bg-white/10 hover:text-white',
                )
              }
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-white/10 p-4">
          <div className="rounded-lg bg-white/5 p-3">
            <p className="truncate text-xs font-semibold text-white">{user.name}</p>
            <p className="mt-0.5 text-[11px] text-teal-300">{user.role.replace(/_/g, ' ')}</p>
            {user.trainingCenter && <p className="mt-1 truncate text-[11px] text-slate-300">{user.trainingCenter.name}</p>}
            {!user.trainingCenter && user.district && (
              <p className="mt-1 truncate text-[11px] text-slate-300">{user.district.name} District</p>
            )}
          </div>
          <button
            onClick={onLogout}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(true)} className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden">
              <Menu className="h-5 w-5" />
            </button>
            <div className="hidden text-xs font-medium text-slate-500 sm:block">
              Directorate of Skill Development &amp; Vocational Certification
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                onClick={() => setNotifOpen((v) => !v)}
                className="relative rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
              >
                <Bell className="h-4 w-4" />
                {notifications.length > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-teal-600 px-1 text-[10px] font-bold text-white">
                    {notifications.length}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="absolute right-0 mt-2 w-80 rounded-xl border border-slate-200 bg-white shadow-lg">
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
                    <span className="text-xs font-semibold text-slate-900">Real-Time Activity</span>
                    {notifications.length > 0 && (
                      <button onClick={clearNotifications} className="text-xs text-teal-700 hover:underline">
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
                    {notifications.length === 0 ? (
                      <p className="p-4 text-center text-xs text-slate-500">No live events yet in this session.</p>
                    ) : (
                      notifications.map((n) => (
                        <div key={n.eventId} className="px-4 py-2.5 text-xs">
                          <div className="font-medium text-slate-800">{n.type.replace(/\./g, ' ')}</div>
                          <div className="mt-0.5 text-slate-500">
                            {n.code ? `Batch ${n.code} ` : ''}
                            {n.certificateNumber ? `${n.certificateNumber} ` : ''}
                            {n.status ? `→ ${n.status}` : ''}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
