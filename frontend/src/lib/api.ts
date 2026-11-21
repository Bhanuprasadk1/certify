import axios from 'axios';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || '';

let accessToken: string | null = sessionStorage.getItem('cf_token');

export function setAccessToken(token: string | null) {
  accessToken = token;
  if (token) sessionStorage.setItem('cf_token', token);
  else sessionStorage.removeItem('cf_token');
}

export function getAccessToken(): string | null {
  return accessToken;
}

export const api = axios.create({
  baseURL: `${API_BASE}/api`,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  (r) => r,
  async (err) => {
    const orig = err.config;
    if (err.response?.status === 401 && orig && !orig._retry && !orig.url?.includes('/auth/login') && !orig.url?.includes('/auth/refresh')) {
      orig._retry = true;
      try {
        if (!refreshing) {
          refreshing = axios
            .post(`${API_BASE}/api/auth/refresh`, {}, { withCredentials: true })
            .then((r) => {
              const t = r.data?.data?.accessToken as string;
              setAccessToken(t);
              return t;
            })
            .catch(() => {
              setAccessToken(null);
              return null;
            })
            .finally(() => {
              refreshing = null;
            });
        }
        const newTok = await refreshing;
        if (newTok) {
          orig.headers.Authorization = `Bearer ${newTok}`;
          return api(orig);
        }
      } catch {
        setAccessToken(null);
      }
    }
    return Promise.reject(err);
  },
);

export function errorMessage(err: unknown, fallback = 'Request failed'): string {
  if (axios.isAxiosError(err)) {
    return (err.response?.data as { message?: string } | undefined)?.message || err.message || fallback;
  }
  return (err as Error)?.message || fallback;
}
