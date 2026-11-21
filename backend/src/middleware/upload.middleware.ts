import multer from 'multer';
import { badRequest } from '../lib/errors.js';

const ALLOWED_EXTS = ['.csv', '.xlsx'];
const ALLOWED_MIMES = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

export const candidateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const okExt = ALLOWED_EXTS.some((ext) => name.endsWith(ext));
    if (!okExt) {
      return cb(badRequest('Only .csv and .xlsx candidate files are supported'));
    }
    if (file.mimetype && !ALLOWED_MIMES.has(file.mimetype)) {
      return cb(badRequest(`Unsupported file MIME type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});
