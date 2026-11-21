import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function ok(res: Response, data: unknown, meta?: Record<string, unknown>, status = 200) {
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function pageMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const uuidParam = z.object({ id: z.string().uuid('Invalid identifier') });

export function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').slice(0, 64);
}
