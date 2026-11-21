import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { parse, unauthorized } from '../lib/errors.js';
import { asyncHandler, clientIp, ok } from '../lib/http.js';
import { getProfile, login, logout, refresh } from '../services/auth.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { loginLimiter } from '../middleware/rateLimit.middleware.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'cf_refresh';

function setRefreshCookie(res: import('express').Response, token: string, expires: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE,
    expires,
    path: '/api/auth',
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(loginSchema, req.body);
    const result = await login(body.email, body.password, clientIp(req), req.headers['user-agent']);
    setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    ok(res, { accessToken: result.accessToken, user: result.user });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = (req.cookies?.[REFRESH_COOKIE] as string | undefined) || (req.body?.refreshToken as string | undefined);
    if (!token) throw unauthorized('Missing refresh token');
    const result = await refresh(token, req.headers['user-agent']);
    setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    ok(res, { accessToken: result.accessToken, user: result.user });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    let sessionId: string | null = null;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        const { resolveUserFromToken } = await import('../services/auth.service.js');
        sessionId = (await resolveUserFromToken(header.slice(7))).sessionId;
      } catch {
        sessionId = null;
      }
    }
    const refreshToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    await logout(sessionId, refreshToken);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    ok(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await getProfile(req.user!.id));
  }),
);

authRouter.get(
  '/demo-users',
  asyncHandler(async (_req, res) => {
    if (!env.DEMO_MODE) return ok(res, []);
    const users = await prisma.user.findMany({
      where: { isActive: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: {
        email: true,
        name: true,
        role: true,
        district: { select: { name: true } },
        trainingCenter: { select: { name: true } },
        roleRef: { select: { name: true } },
      },
    });
    ok(res, users);
  }),
);
