import 'dotenv/config';
import { pgPool, prisma } from '../lib/prisma.js';
import { seedDemoData } from './seed.js';

const reset = process.argv.includes('--reset');
const ifEmpty = process.argv.includes('--if-empty');

try {
  if (ifEmpty && (await prisma.user.count()) > 0) {
    console.log('Seed skipped: database already has users.');
  } else {
    const result = await seedDemoData(reset);
    console.log('CertiFlow seed complete:', result);
  }
} finally {
  await prisma.$disconnect();
  await pgPool.end();
}
