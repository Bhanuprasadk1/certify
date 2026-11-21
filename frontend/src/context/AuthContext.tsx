import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, API_BASE, getAccessToken, setAccessToken } from '../lib/api';
import type { RealtimeEvent, UserProfile } from '../types/api';

interface AuthContextValue {
  user: UserProfile | null;
  loading: boolean;
  socketConnected: boolean;
  notifications: RealtimeEvent[];
  clearNotifications: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function describeEvent(evt: RealtimeEvent): string {
  switch (evt.type) {
    case 'batch.submitted':
      return `Batch ${evt.code ?? ''} submitted for district review`;
    case 'batch.resubmitted':
      return `Batch ${evt.code ?? ''} resubmitted (v${evt.version ?? ''})`;
    case 'batch.district.approved':
      return `Batch ${evt.code ?? ''} cleared District Review → ${evt.status ?? ''}`;
    case 'batch.quality.approved':
      return `Batch ${evt.code ?? ''} cleared Quality Review → State Review`;
    case 'batch.state.approved':
      return `Batch ${evt.code ?? ''} approved by State Office — generating certificates`;
    case 'batch.returned':
      return `Batch ${evt.code ?? ''} returned for corrections`;
    case 'batch.rejected':
      return `Batch ${evt.code ?? ''} was rejected`;
    case 'certificate.generation.progress':
      return `Certificates issued for batch ${evt.code ?? ''} (${evt.done ?? 0}/${evt.total ?? 0})`;
    case 'certificate.cancelled':
      return `Certificate ${evt.certificateNumber ?? ''} cancelled`;
    case 'batch.escalated':
      return evt.message || `Batch ${evt.code ?? ''} escalated (SLA breached)`;
    case 'whatsapp.delivery.completed':
      return `WhatsApp delivery updated: ${evt.status ?? ''}`;
    default:
      return `Event: ${evt.type}`;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [socketConnected, setSocketConnected] = useState(false);
  const [notifications, setNotifications] = useState<RealtimeEvent[]>([]);
  const qc = useQueryClient();

  const bootstrap = useCallback(async () => {
    try {
      if (getAccessToken()) {
        const res = await api.get('/auth/me');
        setUser(res.data.data);
      } else {
        const res = await api.post('/auth/refresh');
        setAccessToken(res.data.data.accessToken);
        setUser(res.data.data);
      }
    } catch {
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!user) {
      setSocketConnected(false);
      return;
    }
    const token = getAccessToken();
    if (!token) return;

    const socket: Socket = io(API_BASE || window.location.origin, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('certiflow:event', (evt: RealtimeEvent) => {
      setNotifications((prev) => [evt, ...prev].slice(0, 25));
      if (evt.type !== 'certificate.generated' && evt.type !== 'whatsapp.delivery.completed') {
        const msg = describeEvent(evt);
        if (evt.type === 'batch.escalated' || evt.type === 'certificate.cancelled' || evt.type === 'batch.rejected') {
          toast.warning(msg);
        } else {
          toast.info(msg);
        }
      }
      // Refresh relevant TanStack queries
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['batches'] });
      void qc.invalidateQueries({ queryKey: ['batch'] });
      void qc.invalidateQueries({ queryKey: ['review-queue'] });
      void qc.invalidateQueries({ queryKey: ['certificates'] });
      void qc.invalidateQueries({ queryKey: ['deliveries'] });
      void qc.invalidateQueries({ queryKey: ['escalations'] });
    });

    return () => {
      socket.disconnect();
    };
  }, [user, qc]);

  const login = async (email: string, password: string) => {
    const res = await api.post('/auth/login', { email, password });
    setAccessToken(res.data.data.accessToken);
    setUser(res.data.data.user);
    qc.clear();
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    setNotifications([]);
    qc.clear();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        socketConnected,
        notifications,
        clearNotifications: () => setNotifications([]),
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
