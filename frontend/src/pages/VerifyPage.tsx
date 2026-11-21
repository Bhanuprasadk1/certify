import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Clock, FileSearch, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatDateTime } from '../components/ui';

interface VerifyResult {
  status: 'VALID' | 'CANCELLED' | 'INVALID' | 'NOT_ISSUED';
  certificateNumber?: string;
  candidateName?: string;
  courseName?: string;
  trainingCenter?: string;
  district?: string;
  completionDate?: string;
  issueDate?: string;
  cancelledAt?: string;
  verifiedAt: string;
}

export function VerifyPage() {
  const { token } = useParams<{ token?: string }>();
  const navigate = useNavigate();
  const [query, setQuery] = useState(token ?? '');
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runVerify = async (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await api.get(`/public/verify/${encodeURIComponent(cleaned)}`);
      setResult(res.data.data as VerifyResult);
    } catch (e) {
      setErr(errorMessage(e, 'Verification service error'));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      setQuery(token);
      void runVerify(token);
    }
  }, [token]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    navigate(`/verify/${encodeURIComponent(query.trim())}`);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-navy-900 text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 font-bold">CF</div>
            <div>
              <div className="text-sm font-bold">Pragati Skills Mission — Public Verification</div>
              <div className="text-[11px] text-teal-300">Official Certificate Authenticity Portal</div>
            </div>
          </div>
          <Link to="/login" className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10">
            Officer Portal
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs sm:p-8">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-teal-700">
            <ShieldCheck className="h-4 w-4" /> Real-Time Registry Verification
          </div>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">Verify a Skilling Certificate</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter a certificate number (e.g., <code className="rounded bg-slate-100 px-1">PSM-2026-...</code>) or scan the QR code on the
            certificate PDF.
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-2.5 sm:flex-row">
            <div className="relative flex-1">
              <FileSearch className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter Certificate Number or Verification Token..."
                className="w-full rounded-lg border border-slate-300 py-2.5 pl-9 pr-3 text-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-navy-900 px-6 py-2.5 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-50"
            >
              {loading ? 'Checking...' : 'Verify'}
            </button>
          </form>

          {err && <div className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{err}</div>}

          {result && (
            <div className="mt-6 overflow-hidden rounded-xl border border-slate-200">
              {/* Status Header */}
              {result.status === 'VALID' && (
                <div className="flex items-center gap-3 bg-emerald-600 px-5 py-4 text-white">
                  <CheckCircle2 className="h-7 w-7 shrink-0" />
                  <div>
                    <div className="text-base font-bold">CERTIFICATE VALID</div>
                    <div className="text-xs text-emerald-100">This certificate is authentic and currently active in the Pragati Skills Mission registry.</div>
                  </div>
                </div>
              )}
              {result.status === 'CANCELLED' && (
                <div className="flex items-center gap-3 bg-rose-700 px-5 py-4 text-white">
                  <XCircle className="h-7 w-7 shrink-0" />
                  <div>
                    <div className="text-base font-bold">CERTIFICATE CANCELLED</div>
                    <div className="text-xs text-rose-100">This certificate has been revoked by the State Approving Authority and is no longer valid.</div>
                  </div>
                </div>
              )}
              {result.status === 'INVALID' && (
                <div className="flex items-center gap-3 bg-slate-800 px-5 py-4 text-white">
                  <ShieldAlert className="h-7 w-7 shrink-0 text-amber-400" />
                  <div>
                    <div className="text-base font-bold">INVALID CERTIFICATE</div>
                    <div className="text-xs text-slate-300">No matching certificate record was found for the supplied identifier.</div>
                  </div>
                </div>
              )}
              {result.status === 'NOT_ISSUED' && (
                <div className="flex items-center gap-3 bg-amber-600 px-5 py-4 text-white">
                  <Clock className="h-7 w-7 shrink-0" />
                  <div>
                    <div className="text-base font-bold">NOT YET ISSUED</div>
                    <div className="text-xs text-amber-100">This certificate record is pending final issuance.</div>
                  </div>
                </div>
              )}

              {/* Minimal, Privacy-Safe Details */}
              <div className="divide-y divide-slate-100 bg-white px-5 py-2 text-sm">
                {result.certificateNumber && (
                  <div className="flex justify-between py-2.5">
                    <span className="text-slate-500">Certificate Number</span>
                    <span className="font-mono font-semibold text-slate-900">{result.certificateNumber}</span>
                  </div>
                )}
                {result.candidateName && (
                  <div className="flex justify-between py-2.5">
                    <span className="text-slate-500">Candidate Name</span>
                    <span className="font-semibold text-slate-900">{result.candidateName}</span>
                  </div>
                )}
                {result.courseName && (
                  <div className="flex justify-between py-2.5">
                    <span className="text-slate-500">Course</span>
                    <span className="font-medium text-slate-900">{result.courseName}</span>
                  </div>
                )}
                {result.trainingCenter && (
                  <div className="flex justify-between py-2.5">
                    <span className="text-slate-500">Training Center</span>
                    <span className="text-right font-medium text-slate-900">
                      {result.trainingCenter}
                      {result.district ? `, ${result.district}` : ''}
                    </span>
                  </div>
                )}
                {result.issueDate && (
                  <div className="flex justify-between py-2.5">
                    <span className="text-slate-500">Issue Date</span>
                    <span className="text-slate-800">{formatDate(result.issueDate)}</span>
                  </div>
                )}
                {result.cancelledAt && (
                  <div className="flex justify-between py-2.5">
                    <span className="text-slate-500">Cancelled On</span>
                    <span className="font-medium text-rose-700">{formatDateTime(result.cancelledAt)}</span>
                  </div>
                )}
                <div className="flex justify-between py-2.5 text-xs">
                  <span className="text-slate-400">Verified Timestamp</span>
                  <span className="font-mono text-slate-500">{formatDateTime(result.verifiedAt)}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
