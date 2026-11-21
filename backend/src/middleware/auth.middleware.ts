import type { NextFunction, Request, Response } from 'express';
import type { RoleCode } from '@prisma/client';
import { resolveUserFromToken, type AuthUser } from '../services/auth.service.js';
import { forbidden, unauthorized } from '../lib/errors.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw unauthorized('Missing Bearer token');
    req.user = await resolveUserFromToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: RoleCode[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`Role ${req.user.role} is not permitted for this operation`));
    }
    next();
  };
}
