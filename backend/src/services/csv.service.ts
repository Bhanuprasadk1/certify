import { parse as parseCsv } from 'csv-parse/sync';
import { readSheet } from 'read-excel-file/node';
import type { FieldError } from '../lib/errors.js';

export interface ParsedCandidateRow {
  rowNumber: number;
  externalId: string | null;
  name: string;
  email: string | null;
  phone: string;
  courseName: string;
  completionDate: Date;
}

export interface CandidateParseResult {
  valid: boolean;
  totalRows: number;
  candidates: ParsedCandidateRow[];
  errors: FieldError[];
}

const HEADER_ALIASES: Record<string, keyof RawRow> = {
  name: 'name',
  full_name: 'name',
  fullname: 'name',
  candidate_name: 'name',
  candidatename: 'name',
  email: 'email',
  email_address: 'email',
  phone: 'phone',
  mobile: 'phone',
  phone_number: 'phone',
  phonenumber: 'phone',
  whatsapp: 'phone',
  course: 'course',
  course_name: 'course',
  coursename: 'course',
  completion_date: 'completionDate',
  completiondate: 'completionDate',
  completed_on: 'completionDate',
  candidate_id: 'externalId',
  candidateid: 'externalId',
  external_id: 'externalId',
  roll_no: 'externalId',
  registration_id: 'externalId',
};

interface RawRow {
  name: string;
  email: string;
  phone: string;
  course: string;
  completionDate: string;
  externalId: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/[\s\-().+]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  // Support 10-digit Indian mobile numbers (6-9 start) or 12-digit with 91 prefix
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && /^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

function parseDateValue(raw: unknown): Date | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
  }
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return dt;
    return null;
  }
  // DD/MM/YYYY or DD-MM-YYYY
  m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return dt;
    return null;
  }
  return null;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

export async function parseCandidateFile(
  buffer: Buffer,
  filename: string,
  defaults: { courseName?: string; completionDate?: Date },
): Promise<CandidateParseResult> {
  const lower = filename.toLowerCase();
  const rawRecords: { rowNumber: number; raw: RawRow }[] = [];

  if (lower.endsWith('.xlsx')) {
    const sheet = await readSheet(buffer);
    if (!sheet.length) {
      return { valid: false, totalRows: 0, candidates: [], errors: [{ row: 1, field: 'file', message: 'Spreadsheet is empty' }] };
    }
    const headers = sheet[0].map((c) => HEADER_ALIASES[normalizeHeader(cellToString(c))]);
    for (let i = 1; i < sheet.length; i++) {
      const row = sheet[i];
      if (!row || row.every((c) => cellToString(c) === '')) continue;
      const raw: RawRow = { name: '', email: '', phone: '', course: '', completionDate: '', externalId: '' };
      headers.forEach((key, idx) => {
        if (key && idx < row.length) raw[key] = cellToString(row[idx]);
      });
      rawRecords.push({ rowNumber: i + 1, raw });
    }
  } else {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    let rows: string[][];
    try {
      rows = parseCsv(text, { relax_column_count: true, skip_empty_lines: true, trim: true }) as string[][];
    } catch (err) {
      return {
        valid: false,
        totalRows: 0,
        candidates: [],
        errors: [{ row: 1, field: 'file', message: `Malformed CSV: ${(err as Error).message}` }],
      };
    }
    if (!rows.length) {
      return { valid: false, totalRows: 0, candidates: [], errors: [{ row: 1, field: 'file', message: 'CSV file is empty' }] };
    }
    const headers = rows[0].map((h) => HEADER_ALIASES[normalizeHeader(h)]);
    if (!headers.includes('name') && !headers.includes('phone')) {
      return {
        valid: false,
        totalRows: 0,
        candidates: [],
        errors: [{ row: 1, field: 'header', message: 'CSV must include at least "name" and "phone" columns' }],
      };
    }
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i];
      if (cols.every((c) => !c.trim())) continue;
      const raw: RawRow = { name: '', email: '', phone: '', course: '', completionDate: '', externalId: '' };
      headers.forEach((key, idx) => {
        if (key && idx < cols.length) raw[key] = (cols[idx] ?? '').trim();
      });
      rawRecords.push({ rowNumber: i + 1, raw });
    }
  }

  if (!rawRecords.length) {
    return { valid: false, totalRows: 0, candidates: [], errors: [{ row: 2, field: 'file', message: 'No candidate rows found' }] };
  }

  const errors: FieldError[] = [];
  const candidates: ParsedCandidateRow[] = [];
  const seenPhones = new Map<string, number>();
  const seenIds = new Map<string, number>();
  const today = new Date();
  today.setUTCHours(23, 59, 59, 999);

  for (const { rowNumber, raw } of rawRecords) {
    let rowOk = true;

    // Name (required, sanitize potential CSV formula injection)
    const cleanName = raw.name.replace(/^[=+\-@]+/, '').trim();
    if (!cleanName || cleanName.length < 2) {
      errors.push({ row: rowNumber, field: 'name', message: 'Candidate name is required (min 2 characters)' });
      rowOk = false;
    } else if (cleanName.length > 120) {
      errors.push({ row: rowNumber, field: 'name', message: 'Candidate name exceeds 120 characters' });
      rowOk = false;
    }

    // Phone (required, valid Indian mobile format)
    const phone = normalizePhone(raw.phone);
    if (!phone) {
      errors.push({ row: rowNumber, field: 'phone', message: 'Invalid phone number (expected 10-digit mobile or +91XXXXXXXXXX)' });
      rowOk = false;
    } else if (seenPhones.has(phone)) {
      errors.push({ row: rowNumber, field: 'phone', message: `Duplicate phone number (already listed on row ${seenPhones.get(phone)})` });
      rowOk = false;
    } else {
      seenPhones.set(phone, rowNumber);
    }

    // Email (optional, validated if provided)
    let email: string | null = null;
    if (raw.email) {
      if (!EMAIL_RE.test(raw.email) || raw.email.length > 160) {
        errors.push({ row: rowNumber, field: 'email', message: 'Invalid email address' });
        rowOk = false;
      } else {
        email = raw.email.toLowerCase();
      }
    }

    // Course (falls back to batch course if blank)
    const courseName = (raw.course || defaults.courseName || '').replace(/^[=+\-@]+/, '').trim();
    if (!courseName || courseName.length < 2) {
      errors.push({ row: rowNumber, field: 'course', message: 'Course name is required' });
      rowOk = false;
    }

    // Completion date (falls back to batch completion date if blank)
    let completionDate: Date | null = null;
    if (raw.completionDate) {
      completionDate = parseDateValue(raw.completionDate);
      if (!completionDate) {
        errors.push({ row: rowNumber, field: 'completion_date', message: 'Invalid completion date (use YYYY-MM-DD or DD/MM/YYYY)' });
        rowOk = false;
      }
    } else if (defaults.completionDate) {
      completionDate = defaults.completionDate;
    } else {
      errors.push({ row: rowNumber, field: 'completion_date', message: 'Completion date is required' });
      rowOk = false;
    }

    // External candidate ID (optional, unique within batch if supplied)
    let externalId: string | null = null;
    if (raw.externalId) {
      externalId = raw.externalId.replace(/^[=+\-@]+/, '').trim();
      if (externalId.length > 64) {
        errors.push({ row: rowNumber, field: 'candidate_id', message: 'Candidate ID exceeds 64 characters' });
        rowOk = false;
      } else if (seenIds.has(externalId.toLowerCase())) {
        errors.push({
          row: rowNumber,
          field: 'candidate_id',
          message: `Duplicate candidate ID (already listed on row ${seenIds.get(externalId.toLowerCase())})`,
        });
        rowOk = false;
      } else {
        seenIds.set(externalId.toLowerCase(), rowNumber);
      }
    }

    if (rowOk && phone && completionDate) {
      candidates.push({
        rowNumber,
        externalId,
        name: cleanName,
        email,
        phone,
        courseName,
        completionDate,
      });
    }
  }

  return {
    valid: errors.length === 0,
    totalRows: rawRecords.length,
    candidates: errors.length === 0 ? candidates : [],
    errors,
  };
}
