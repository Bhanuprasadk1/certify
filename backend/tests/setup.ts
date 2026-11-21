import 'dotenv/config';

process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.QUEUE_DRIVER = 'memory';
process.env.REDIS_URL = '';
process.env.STORAGE_DIR = './storage-test';
process.env.DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@1234';
