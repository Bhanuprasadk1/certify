import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '••••';
  return `+${digits.slice(0, 2)} ${digits.slice(2, 4)}••••••${digits.slice(-2)}`;
}

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [u, d] = email.split('@');
  return `${u.slice(0, 1)}•••@${d}`;
}

export function safeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}
