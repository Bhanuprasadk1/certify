import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { BatchesPage } from './pages/BatchesPage';
import { CreateBatchPage } from './pages/CreateBatchPage';
import { BatchDetailPage } from './pages/BatchDetailPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { CertificatesPage } from './pages/CertificatesPage';
import { VerifyPage } from './pages/VerifyPage';
import { DeliveriesPage } from './pages/DeliveriesPage';
import { EscalationsPage } from './pages/EscalationsPage';
import { AuditLogsPage } from './pages/AuditLogsPage';
import { AdminPage } from './pages/AdminPage';
import type { RoleCode } from './types/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
  },
});

function ProtectedRoute({ children, roles }: { children: React.ReactNode; roles?: RoleCode[] }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        Loading CertiFlow session...
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Toaster position="top-right" richColors closeButton />
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/verify" element={<VerifyPage />} />
            <Route path="/verify/:token" element={<VerifyPage />} />

            <Route
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="batches" element={<BatchesPage />} />
              <Route
                path="batches/new"
                element={
                  <ProtectedRoute roles={['TRAINING_CENTER']}>
                    <CreateBatchPage />
                  </ProtectedRoute>
                }
              />
              <Route path="batches/:id" element={<BatchDetailPage />} />
              <Route
                path="reviews/district"
                element={
                  <ProtectedRoute roles={['DISTRICT_OFFICER', 'SUPER_ADMIN']}>
                    <ReviewQueuePage stage="district" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="reviews/quality"
                element={
                  <ProtectedRoute roles={['QUALITY_OFFICER', 'SUPER_ADMIN']}>
                    <ReviewQueuePage stage="quality" />
                  </ProtectedRoute>
                }
              />
              <Route
                path="reviews/state"
                element={
                  <ProtectedRoute roles={['STATE_OFFICER', 'SUPER_ADMIN']}>
                    <ReviewQueuePage stage="state" />
                  </ProtectedRoute>
                }
              />
              <Route path="certificates" element={<CertificatesPage />} />
              <Route path="deliveries" element={<DeliveriesPage />} />
              <Route
                path="escalations"
                element={
                  <ProtectedRoute roles={['STATE_OFFICER', 'SUPER_ADMIN', 'DISTRICT_OFFICER', 'QUALITY_OFFICER']}>
                    <EscalationsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="audit-logs"
                element={
                  <ProtectedRoute roles={['STATE_OFFICER', 'SUPER_ADMIN']}>
                    <AuditLogsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="admin"
                element={
                  <ProtectedRoute roles={['SUPER_ADMIN', 'STATE_OFFICER']}>
                    <AdminPage />
                  </ProtectedRoute>
                }
              />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
