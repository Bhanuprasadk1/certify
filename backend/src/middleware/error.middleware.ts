import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AppError } from '../lib/errors.js';
import { isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Endpoint not found' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.errors ? { errors: err.errors } : {}),
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file exceeds the 5 MB size limit' : err.message;
    res.status(400).json({ success: false, code: 'UPLOAD_ERROR', message: msg });
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ success: false, code: 'INVALID_JSON', message: 'Malformed JSON request body' });
    return;
  }

  logger.error('unhandled error', { path: req.path, method: req.method, err });
  res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: isProd ? 'An unexpected server error occurred' : (err as Error)?.message || 'Internal error',
  });
}
