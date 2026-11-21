import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { RoleCode } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { audit } from './audit.service.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: RoleCode;
  districtId: string | null;
  trainingCenterId: string | null;
  affiliatedTrainingCenterId: string | null;
  sessionId: string;
}

interface AccessPayload {
  sub: string;
  sid: string;
  role: RoleCode;
}

const ISSUER = 'certiflow';
const AUDIENCE = 'certiflow-api';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Pre-computed hash used to equalise timing when the e-mail does not exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-password', 10);

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);

export function signAccessToken(p: AccessPayload): string {
  return jwt.sign(p, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    if (typeof p !== 'object' || !p.sub || !(p as AccessPayload).sid) throw new Error('bad payload');
    return p as unknown as AccessPayload;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

/** Resolve the authoritative identity for a token: session must be live and user active. */
export async function resolveUserFromToken(token: string): Promise<AuthUser> {
  const payload = verifyAccessToken(token);
  const session = await prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub || !session.user.isActive) {
    throw unauthorized('Session is no longer valid');
  }
  const u = session.user;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    districtId: u.districtId,
    trainingCenterId: u.trainingCenterId,
    affiliatedTrainingCenterId: u.affiliatedTrainingCenterId,
    sessionId: session.id,
  };
}

async function createSession(userId: string, role: RoleCode, userAgent?: string) {
  const refreshToken = randomToken(48);
  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      userAgent: userAgent?.slice(0, 200),
    },
  });
  const accessToken = signAccessToken({ sub: userId, sid: session.id, role });
  return { accessToken, refreshToken, refreshExpiresAt: session.expiresAt };
}

export async function login(email: string, password: string, ip: string, userAgent?: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    await audit({ action: 'auth.login.failed', resourceType: 'User', metadata: { reason: 'unknown_user' }, ip });
    throw unauthorized('Invalid email or password');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ actor: user, action: 'auth.login.locked', resourceType: 'User', resourceId: user.id, ip });
    throw unauthorized('Account temporarily locked due to repeated failed logins. Try again later.');
  }
  const okPw = await bcrypt.compare(password, user.passwordHash);
  if (!okPw || !user.isActive) {
    const failed = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed >= MAX_FAILED ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    await audit({ actor: user, action: 'auth.login.failed', resourceType: 'User', resourceId: user.id, ip, metadata: { failed } });
    throw unauthorized('Invalid email or password');
  }
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const tokens = await createSession(user.id, user.role, userAgent);
  await audit({ actor: user, action: 'auth.login', resourceType: 'User', resourceId: user.id, ip });
  return { ...tokens, user: await getProfile(user.id) };
}

/** Refresh-token rotation: the old session is revoked and a new one issued. Reuse of a revoked token revokes all sessions. */
export async function refresh(refreshToken: string, userAgent?: string) {
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(refreshToken) }, include: { user: true } });
  if (!session) throw unauthorized('Invalid refresh token');
  if (session.revokedAt) {
    await prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit({ actor: session.user, action: 'auth.refresh.reuse_detected', resourceType: 'User', resourceId: session.userId });
    throw unauthorized('Refresh token reuse detected; please sign in again');
  }
  if (session.expiresAt < new Date() || !session.user.isActive) throw unauthorized('Session expired');
  const rotated = await prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (rotated.count !== 1) throw unauthorized('Session already rotated');
  const tokens = await createSession(session.userId, session.user.role, userAgent);
  return { ...tokens, user: await getProfile(session.userId) };
}

export async function logout(sessionId: string | null, refreshToken?: string) {
  if (sessionId) await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (refreshToken) await prisma.session.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function getProfile(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { district: true, trainingCenter: true, roleRef: true },
  });
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    roleName: u.roleRef.name,
    district: u.district ? { id: u.district.id, name: u.district.name, code: u.district.code } : null,
    trainingCenter: u.trainingCenter ? { id: u.trainingCenter.id, name: u.trainingCenter.name, code: u.trainingCenter.code } : null,
    lastLoginAt: u.lastLoginAt,
  };
}
