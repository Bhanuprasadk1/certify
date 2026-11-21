# CertiFlow — Skilling Certificate Issuance & Verification Platform

**Pragati Skills Mission** • Directorate of Skill Development & Vocational Certification

CertiFlow is a full-stack, security-hardened, event-driven certificate issuance and verification platform built for government skilling programs. It orchestrates training batches from atomic CSV/Excel ingestion through concurrency-safe multi-officer approvals, conditional quality inspection, asynchronous PDF generation with embedded QR codes, retryable WhatsApp mock delivery, instant certificate cancellation, stuck-batch SLA escalations, and real-time public verification.

---

## Problem Statement

Government skilling initiatives process thousands of candidate cohorts across hundreds of training centers and districts. Paper and spreadsheet-driven approval chains suffer from:

- Partial or corrupted candidate imports.
- Weak role and district isolation (cross-district or self-approval fraud).
- Race conditions when multiple officers approve a batch simultaneously.
- Duplicate certificates or dropped notifications during worker crashes.
- Stale verification portals that still show revoked certificates as valid.
- Batches silently stalling in review queues with no SLA visibility.

## Solution

CertiFlow enforces every workflow invariant on the server and in PostgreSQL:

```
Training Center (DRAFT)
   │  Atomic CSV/XLSX upload + validation
   ▼
SUBMITTED ──► DISTRICT_REVIEW (2 distinct District Officers, row-locked)
                  │
                  ├─── (< quality threshold) ───────────────┐
                  ▼                                         │
             QUALITY_REVIEW (>= 50 candidates, configurable)│
                  │                                         │
                  └───────────────────► STATE_REVIEW ◄──────┘
                                             │
                                             ▼
                                         APPROVED
                                             │ (Transactional Outbox → RabbitMQ)
                                             ▼
                                  CERTIFICATE_PROCESSING
                                             │ (Idempotent PDFKit + QR generation)
                                             ▼
                                   CERTIFICATES_ISSUED
                                             │ (Async WhatsApp Mock + exponential backoff)
                                             ▼
                                   PUBLIC VERIFICATION
```

- **Returned batches** (`RETURNED`) notify the training center with a mandatory reason, allow editing, and increment `batch.version` on resubmission so previous approvals remain in audit history but never count toward the new version.
- **Rejected batches** (`REJECTED`) are terminal and require creating a new batch.

---

## Key Features

- **Strict Authentication & RBAC**: `bcryptjs` password hashing, HS256 JWT access tokens + HTTP-only rotating refresh tokens (with reuse detection), brute-force lockout, and server-side route/resource authorization.
- **Data Isolation & Conflict-of-Interest**: Training centers only see their own batches; District Officers only see their assigned district; officers affiliated with a training center are blocked from approving its batches.
- **Atomic CSV / Excel Ingestion**: Supports `.csv` and `.xlsx`, sanitizes formula injection, validates name, phone, email, course, completion date, and intra-batch uniqueness, and returns row-numbered errors while saving **zero** records on failure.
- **Concurrency-Safe Dual Approvals**: Uses PostgreSQL `SELECT ... FOR UPDATE` row locking + unique `(batchId, version, stage, reviewerId)` constraints so concurrent approvals both record cleanly and advance the workflow **exactly once**.
- **Real PDF Certificates with QR Codes**: Generates A4 landscape certificates via `pdfkit` + `qrcode` stored outside public web roots and served only after authorization checks.
- **Authoritative Public Verification**: `GET /api/public/verify/:token` (supports token or certificate number) reads PostgreSQL directly so cancellations reflect **immediately**, exposes zero sensitive PII, and is rate-limited.
- **State-Office-Only Cancellation**: Transactional revocation with mandatory reason, immutable audit entry, immediate public `CANCELLED` status, and blocked PDF downloads (`410 Gone`).
- **Transactional Outbox & Event-Driven Workers**: Business state updates and `OutboxEvent` writes commit in the same PostgreSQL transaction. Separate workers handle Outbox publishing, Certificate generation, WhatsApp mock delivery (with exponential backoff & idempotency keys), and Stuck-batch SLA escalations.
- **Real-Time Updates (Socket.IO)**: JWT-authenticated Socket.IO with strictly server-controlled rooms (`user:*`, `role:*`, `district:*`, `center:*`)—clients cannot join arbitrary rooms.
- **Immutable Audit Trail**: Append-only `AuditLog` table protected by a PostgreSQL `BEFORE UPDATE OR DELETE` trigger.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, Vite 7, TypeScript, Tailwind CSS 4, React Router 6, TanStack Query, Axios, React Hook Form, Zod, Recharts, Lucide React, Socket.IO Client, Sonner |
| **Backend** | Node.js, Express 4, TypeScript, Prisma ORM 6, Zod, Helmet, CORS, Express Rate Limit, Multer, `csv-parse`, `read-excel-file`, PDFKit, QRCode, Socket.IO |
| **Data & Messaging** | PostgreSQL 17, Redis 7, RabbitMQ 3.13 (with in-process `MemoryBus` fallback for zero-Docker local runs) |
| **Testing & Containers** | Vitest, Supertest, Docker, Multi-stage Dockerfiles, Docker Compose (`bhanuprasadk1/certiflow-*`) |

---

## Demo Accounts

All seeded accounts share the local demo password **`Demo@1234`** (configured via `DEMO_PASSWORD`; **never** use in production).

| Name | Email | Role | Scope / Notes |
|---|---|---|---|
| **Anika Sharma** | `anika@certiflow.gov.in` | `TRAINING_CENTER` | Pragati Vocational Center, Pune (`PVC-PUN`) |
| **Rohan Deshpande** | `rohan@certiflow.gov.in` | `TRAINING_CENTER` | Sahyadri Skill Hub, Pune (`SSH-PUN`) — cross-center isolation |
| **Dev Kulkarni** | `dev@certiflow.gov.in` | `DISTRICT_OFFICER` | Pune District |
| **Meera Joshi** | `meera@certiflow.gov.in` | `DISTRICT_OFFICER` | Pune District |
| **Kabir Deshmukh** | `kabir@certiflow.gov.in` | `DISTRICT_OFFICER` | Nagpur District (affiliated with `VTI-NAG` for conflict-of-interest demo) |
| **Neha Iyer** | `neha@certiflow.gov.in` | `QUALITY_OFFICER` | Global Quality Review (`>= 50` candidates) |
| **Farah Khan** | `farah@certiflow.gov.in` | `STATE_OFFICER` | State Final Approval, Cancellation, Escalations |
| **System Admin** | `admin@certiflow.gov.in` | `SUPER_ADMIN` | Settings, Users, Audit Logs, System Health, Demo Reset |

Sample CSV files for live demos are provided in `demo-data/`:
- `demo-data/valid-candidates.csv` (6 valid candidates)
- `demo-data/invalid-candidates.csv` (missing name, bad phone, bad email, duplicate phone)
- `demo-data/60-candidates.csv` (60 candidates to trigger Quality Review & batch certificate generation)

---

## Quick Start

See [SETUP.md](SETUP.md) for complete fresh-clone instructions and [DEPLOYMENT.md](DEPLOYMENT.md) for production architecture and scaling analysis.

### Option 1: Docker Compose (Full Stack with PostgreSQL, Redis, RabbitMQ & Separate Workers)

```bash
git clone https://github.com/Bhanuprasadk1/certify.git
cd certify
cp .env.example .env
docker compose up --build
```

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:4000`
- RabbitMQ Management UI: `http://localhost:15672` (`certiflow` / `certiflow`)
- Docker Hub images are configured under `bhanuprasadk1/certiflow-backend:latest` and `bhanuprasadk1/certiflow-frontend:latest` (`https://app.docker.com/accounts/bhanuprasadk1`).

### Option 2: Local Node.js Development (with PostgreSQL)

```bash
# Terminal 1 — Backend API + embedded workers
cd backend
npm install
npx prisma migrate deploy
npm run db:seed:if-empty
npm run dev

# Terminal 2 — Frontend Vite dev server
cd frontend
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:4000`

### Running Automated Tests

```bash
cd backend
npm test
```

### Fast Demo Data Reset

- From UI: Sign in as **System Admin** → **Admin & Health** → **Reset Demo Data**.
- From CLI: `npm --prefix backend run db:reset-demo`.

---

## Screenshots

Add hackathon demo screenshots here:
- `docs/screenshots/login.png` — Login & Demo Persona Picker
- `docs/screenshots/dashboard.png` — Role-Specific Dashboard & Charts
- `docs/screenshots/batch-upload.png` — Atomic CSV Validation & Preview
- `docs/screenshots/certificate-verify.png` — Public Verification Portal (`VALID` vs `CANCELLED`)

---

## Known Limitations

- **WhatsApp Delivery is a Mock Provider**: Deliberately simulated (`SUCCESS`, `TIMEOUT`, `FAILURE` modes) with provider-side idempotency deduplication; no external WhatsApp Business API credentials are required. External messaging is at-least-once from the queue paired with idempotent DB/provider keys, not mathematically exactly-once across third-party networks.
- **Local File Storage for PDFs**: In the hackathon demo, generated PDFs are stored on a shared Docker volume (`./storage/certificates`). Production deployment should use S3/GCS with KMS encryption (detailed in `DEPLOYMENT.md`).
- **Demo SLA Defaults**: Stage SLAs default to 30 minutes (configurable in Admin Settings) and include a `Simulate Stuck SLA` button for rapid demonstration.

---

## AI Usage Disclosure

AI-assisted engineering tools were used during this hackathon build for scaffolding, TypeScript/Prisma implementation, test authoring, and documentation drafting. All critical workflows, security boundaries, database migrations, and automated integration/concurrency tests were executed and verified against a live PostgreSQL instance.
