import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Award, FileSearch, Lock, Mail, ShieldCheck, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorBanner } from '../components/ui';

interface DemoUser {
  email: string;
  name: string;
  role: string;
  district?: { name: string } | null;
  trainingCenter?: { name: string } | null;
  roleRef: { name: string };
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const demoQuery = useQuery({
    queryKey: ['demo-users'],
    queryFn: async () => (await api.get('/auth/demo-users')).data.data as DemoUser[],
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      toast.success('Signed in successfully');
      navigate('/');
    } catch (err) {
      setError(errorMessage(err, 'Invalid credentials'));
    } finally {
      setSubmitting(false);
    }
  };

  const selectDemoUser = (u: DemoUser) => {
    setEmail(u.email);
    setPassword('Demo@1234');
    setError(null);
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 lg:flex-row">
      {/* Left Brand Panel */}
      <div className="flex flex-col justify-between bg-navy-900 p-8 text-white lg:w-[44%] lg:p-12">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-600 text-lg font-bold">CF</div>
            <div>
              <div className="text-lg font-bold tracking-tight">CertiFlow</div>
              <div className="text-xs text-teal-300">Pragati Skills Mission</div>
            </div>
          </div>

          <h1 className="mt-10 text-3xl font-bold leading-tight tracking-tight">
            Trusted Skilling Certificate Issuance &amp; Verification
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300">
            End-to-end multi-level approval workflow with district isolation, concurrency-safe dual approvals, quality audits,
            tamper-evident PDF certificates with QR codes, and real-time public verification.
          </p>

          <div className="mt-8 space-y-3 text-sm text-slate-200">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-teal-400" />
              <span>Role-Based Access Control &amp; District/Center Isolation</span>
            </div>
            <div className="flex items-center gap-3">
              <Award className="h-5 w-5 text-teal-400" />
              <span>Idempotent Asynchronous PDF Generation &amp; WhatsApp Delivery</span>
            </div>
            <div className="flex items-center gap-3">
              <FileSearch className="h-5 w-5 text-teal-400" />
              <span>Instant Authoritative Public Certificate Verification</span>
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-white/10 pt-6">
          <Link
            to="/verify"
            className="inline-flex items-center gap-2 rounded-lg border border-teal-400/40 bg-teal-600/20 px-4 py-2.5 text-sm font-medium text-teal-200 hover:bg-teal-600/30"
          >
            <FileSearch className="h-4 w-4" /> Verify a Certificate Publicly (No Login Required)
          </Link>
        </div>
      </div>

      {/* Right Sign-In Form + Demo Persona Picker */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-xl space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
            <h2 className="text-xl font-semibold text-slate-900">Sign in to CertiFlow</h2>
            <p className="mt-1 text-sm text-slate-500">Use your official Pragati Skills Mission credentials.</p>

            {error && (
              <div className="mt-4">
                <ErrorBanner message={error} />
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-slate-600">Email Address</label>
                <div className="relative mt-1.5">
                  <Mail className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@certiflow.gov.in"
                    className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium uppercase tracking-wider text-slate-600">Password</label>
                <div className="relative mt-1.5">
                  <Lock className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-navy-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-50"
              >
                {submitting ? 'Authenticating...' : 'Sign In'}
              </button>
            </form>
          </div>

          {/* Seeded Demo Accounts Selector (fills email & local demo password, still submits real auth) */}
          {demoQuery.data && demoQuery.data.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                  <UserCheck className="h-4 w-4 text-teal-600" /> Hackathon Demo Accounts
                </div>
                <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">Password: Demo@1234</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">Click any persona to populate credentials, then click Sign In.</p>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {demoQuery.data.map((u) => (
                  <button
                    key={u.email}
                    type="button"
                    onClick={() => selectDemoUser(u)}
                    className="flex flex-col rounded-lg border border-slate-200 p-2.5 text-left transition hover:border-teal-600 hover:bg-teal-50/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900">{u.name}</span>
                      <span className="rounded bg-navy-900/10 px-1.5 py-0.5 text-[10px] font-semibold text-navy-900">
                        {u.role.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <span className="mt-0.5 truncate text-[11px] text-slate-500">
                      {u.trainingCenter?.name || (u.district ? `${u.district.name} District` : u.email)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
