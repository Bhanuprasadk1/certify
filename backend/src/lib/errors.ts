import { ZodError, type ZodTypeAny, type z } from 'zod';

export interface FieldError {
  row?: number;
  field: string;
  message: string;
}

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public errors?: FieldError[],
  ) {
    super(message);
  }
}

export const badRequest = (m = 'Bad request', errors?: FieldError[]) => new AppError(400, 'BAD_REQUEST', m, errors);
export const unauthorized = (m = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', m);
export const forbidden = (m = 'You are not allowed to perform this action') => new AppError(403, 'FORBIDDEN', m);
export const notFound = (m = 'Resource not found') => new AppError(404, 'NOT_FOUND', m);
export const conflict = (m: string) => new AppError(409, 'CONFLICT', m);
export const gone = (m: string) => new AppError(410, 'GONE', m);
export const unprocessable = (m: string, errors?: FieldError[]) => new AppError(422, 'VALIDATION_FAILED', m, errors);

export function zodToFieldErrors(err: ZodError): FieldError[] {
  return err.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
}

/** Parse untrusted input with a Zod schema, throwing a 400 with field errors on failure. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Request validation failed', zodToFieldErrors(r.error));
  return r.data;
}
