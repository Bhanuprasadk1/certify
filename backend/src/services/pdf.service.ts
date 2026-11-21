import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { env } from '../config/env.js';

export interface CertificatePdfInput {
  certificateNumber: string;
  verificationToken: string;
  candidateName: string;
  courseName: string;
  trainingCenterName: string;
  districtName: string;
  completionDate: Date;
  issueDate: Date;
  status: string;
}

export function certificateStorageRoot(): string {
  return path.resolve(env.STORAGE_DIR, 'certificates');
}

export function verificationUrlFor(token: string): string {
  return `${env.PUBLIC_APP_URL.replace(/\/$/, '')}/verify/${encodeURIComponent(token)}`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Generates a print-ready A4 landscape government skill certificate PDF with an embedded QR code
 * pointing to the public verification endpoint. Writes atomically via temp file + rename.
 */
export async function generateCertificatePdf(data: CertificatePdfInput): Promise<string> {
  const root = certificateStorageRoot();
  await fs.mkdir(root, { recursive: true });
  const filename = `${data.certificateNumber.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
  const finalPath = path.join(root, filename);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;

  const verifyUrl = verificationUrlFor(data.verificationToken);
  const qrBuffer = await QRCode.toBuffer(verifyUrl, {
    type: 'png',
    width: 140,
    margin: 1,
    color: { dark: '#0f2744', light: '#ffffff' },
  });

  const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: `Certificate ${data.certificateNumber}`, Author: 'Pragati Skills Mission — CertiFlow' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const w = doc.page.width;
    const h = doc.page.height;

    // Background & double official border
    doc.rect(0, 0, w, h).fill('#fcfdff');
    doc.lineWidth(4).strokeColor('#0f2744').rect(22, 22, w - 44, h - 44).stroke();
    doc.lineWidth(1.2).strokeColor('#0d7a6f').rect(30, 30, w - 60, h - 60).stroke();

    // Header band
    doc.rect(31, 31, w - 62, 74).fill('#0f2744');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('PRAGATI SKILLS MISSION', 50, 46, { align: 'center', width: w - 100 });
    doc.fillColor('#99e2d8').font('Helvetica').fontSize(10).text('DIRECTORATE OF SKILL DEVELOPMENT & VOCATIONAL CERTIFICATION  •  GOVERNMENT INITIATIVE', 50, 74, {
      align: 'center',
      width: w - 100,
    });

    // Title
    doc.fillColor('#0d7a6f').font('Helvetica-Bold').fontSize(12).text('OFFICIAL SKILL CERTIFICATION', 50, 126, { align: 'center', width: w - 100, characterSpacing: 2 });
    doc.fillColor('#0f2744').font('Helvetica-Bold').fontSize(28).text('Certificate of Completion', 50, 146, { align: 'center', width: w - 100 });

    // Body
    doc.fillColor('#475569').font('Helvetica').fontSize(12).text('This is to certify that', 50, 198, { align: 'center', width: w - 100 });
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(26).text(data.candidateName, 50, 220, { align: 'center', width: w - 100 });
    doc.moveTo(w / 2 - 170, 256).lineTo(w / 2 + 170, 256).lineWidth(1).strokeColor('#cbd5e1').stroke();

    doc.fillColor('#334155').font('Helvetica').fontSize(12).text('has successfully completed the vocational training programme in', 50, 272, {
      align: 'center',
      width: w - 100,
    });
    doc.fillColor('#0f2744').font('Helvetica-Bold').fontSize(18).text(data.courseName, 50, 296, { align: 'center', width: w - 100 });

    doc
      .fillColor('#475569')
      .font('Helvetica')
      .fontSize(11.5)
      .text(`conducted at ${data.trainingCenterName}, ${data.districtName} District`, 50, 328, { align: 'center', width: w - 100 });
    doc.text(`Completed on ${fmtDate(data.completionDate)}`, 50, 348, { align: 'center', width: w - 100 });

    // Metadata box (left) + Signatures (center) + QR code (right)
    const footerY = 408;

    doc.roundedRect(52, footerY, 270, 114, 6).fillAndStroke('#f1f5f9', '#cbd5e1');
    doc.fillColor('#0f2744').font('Helvetica-Bold').fontSize(9.5).text('CERTIFICATE RECORD', 66, footerY + 12);
    doc.fillColor('#334155').font('Helvetica').fontSize(9);
    doc.text(`Certificate No:  ${data.certificateNumber}`, 66, footerY + 30);
    doc.text(`Issue Date:       ${fmtDate(data.issueDate)}`, 66, footerY + 46);
    doc.text(`Status at Issue: ${data.status}`, 66, footerY + 62);
    doc.fillColor('#0d7a6f').fontSize(8).text('Verify authenticity at:', 66, footerY + 80);
    doc.fillColor('#0f2744').fontSize(7.5).text(verifyUrl, 66, footerY + 92, { width: 242, ellipsis: true });

    // Authorizing signature block
    doc.moveTo(356, footerY + 76).lineTo(576, footerY + 76).lineWidth(1).strokeColor('#64748b').stroke();
    doc.fillColor('#0f2744').font('Helvetica-Bold').fontSize(10).text('State Approving Authority', 356, footerY + 84, { width: 220, align: 'center' });
    doc.fillColor('#64748b').font('Helvetica').fontSize(8.5).text('Pragati Skills Mission • Digital Seal', 356, footerY + 99, { width: 220, align: 'center' });

    // QR Code block
    doc.roundedRect(w - 178, footerY - 6, 126, 126, 6).fillAndStroke('#ffffff', '#cbd5e1');
    doc.image(qrBuffer, w - 165, footerY + 2, { width: 100, height: 100 });
    doc.fillColor('#475569').font('Helvetica').fontSize(7.5).text('Scan to verify', w - 178, footerY + 105, { width: 126, align: 'center' });

    doc.end();
  });

  await fs.writeFile(tmpPath, pdfBuffer);
  await fs.rename(tmpPath, finalPath);
  return filename;
}

export async function readCertificatePdf(storedFilename: string): Promise<Buffer | null> {
  // Prevent path traversal: resolve strictly inside certificateStorageRoot
  const root = certificateStorageRoot();
  const resolved = path.resolve(root, path.basename(storedFilename));
  if (!resolved.startsWith(root)) return null;
  try {
    return await fs.readFile(resolved);
  } catch {
    return null;
  }
}
