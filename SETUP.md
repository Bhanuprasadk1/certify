# CertiFlow — Fresh Clone Setup Guide

Follow these steps to run **CertiFlow** from a clean clone on any machine with Docker installed. No locally installed PostgreSQL, Redis, RabbitMQ, or Node.js is required for Docker mode.

---

## Prerequisites

- **Docker Engine 24+** and **Docker Compose v2** (`docker compose version`) — e.g., Docker Desktop on Windows/macOS or Docker Engine on Linux.
- *(Optional, only for local non-Docker dev/tests)*: Node.js 20+ and npm 10+.

---

## 1. Clone the Repository

```bash
git clone https://github.com/Bhanuprasadk1/certify.git
cd certify
```

---

## 2. Create `.env` from `.env.example`

**macOS / Linux / Git Bash:**
```bash
cp .env.example .env
```

**Windows PowerShell:**
```powershell
Copy-Item .env.example .env
```

**Windows Command Prompt (`cmd`):**
```cmd
copy .env.example .env
```

### Important Environment Variables

The defaults in `.env.example` are ready for immediate local hackathon evaluation. Review these key values in `.env`:

| Variable | Purpose | Demo Default |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credentials for the containerized PostgreSQL 17 database | `postgres` / `postgres` / `certiflow` |
| `RABBITMQ_DEFAULT_USER` / `RABBITMQ_DEFAULT_PASS` | Credentials for the containerized RabbitMQ 3.13 broker | `certiflow` / `certiflow` |
| `JWT_ACCESS_SECRET` | HS256 JWT signing secret (**must be >= 32 characters**) | dev-only placeholder |
| `DEMO_MODE` / `DEMO_PASSWORD` | Enables demo persona login selector, demo reset, and seeded password | `true` / `Demo@1234` |
| `PUBLIC_APP_URL` / `CORS_ORIGINS` | Public verification URL encoded into QR codes & allowed browser origins | `http://localhost:3000` |
| `FRONTEND_PORT` / `API_PORT` / `POSTGRES_PORT` / `REDIS_PORT` / `RABBITMQ_PORT` | Host port mappings (change if any port is already in use on your host) | `3000`, `4000`, `5432`, `6379`, `5672` |

> **Security Note:** All credentials and secrets in `.env.example` are **development/demo values only**. Never commit `.env` files to Git (they are excluded by `.gitignore`) and always replace `JWT_ACCESS_SECRET`, database/broker passwords, and disable `DEMO_MODE=false` in production.

---

## 3. Start the Full Application with Docker Compose

```bash
docker compose up --build
```
*(To run in the background, use `docker compose up --build -d` and check status with `docker compose ps`.)*

### What Happens Automatically on First Startup

1. `postgres`, `redis`, and `rabbitmq` start inside Docker and pass health checks (nothing on your host machine is required).
2. `migrate-and-seed` waits for `postgres`, executes **`npx prisma migrate deploy`** (creating all tables, constraints, indexes, and the append-only `AuditLog` trigger), and runs **`node dist/seed/run.js --if-empty`** to seed all demo accounts, districts, training centers, batches, and sample PDF certificates automatically.
3. `api`, `certificate-worker`, `delivery-worker`, `outbox-publisher`, `scheduler`, and `frontend` start in dependency order.

---

## 4. Access the Application

| Service | URL | Notes |
|---|---|---|
| **CertiFlow Web App** | http://localhost:3000 | Login & role-specific dashboards |
| **Public Certificate Verification** | http://localhost:3000/verify | No login required |
| **Backend API & Health Check** | http://localhost:4000/api/health | Live DB, Redis, and RabbitMQ health |
| **RabbitMQ Management UI** | http://localhost:15672 | Login: `certiflow` / `certiflow` |

### Seeded Demo Accounts (Password: `Demo@1234`)

| Name | Email | Role | Scope |
|---|---|---|---|
| Anika Sharma | `anika@certiflow.gov.in` | `TRAINING_CENTER` | Pragati Vocational Center, Pune |
| Rohan Deshpande | `rohan@certiflow.gov.in` | `TRAINING_CENTER` | Sahyadri Skill Hub, Pune (isolation demo) |
| Dev Kulkarni | `dev@certiflow.gov.in` | `DISTRICT_OFFICER` | Pune District (Approver 1) |
| Meera Joshi | `meera@certiflow.gov.in` | `DISTRICT_OFFICER` | Pune District (Approver 2) |
| Kabir Deshmukh | `kabir@certiflow.gov.in` | `DISTRICT_OFFICER` | Nagpur District (district isolation & conflict-of-interest demo) |
| Neha Iyer | `neha@certiflow.gov.in` | `QUALITY_OFFICER` | Large cohorts (`>= 50` candidates) |
| Farah Khan | `farah@certiflow.gov.in` | `STATE_OFFICER` | Final issuance, cancellation, escalations |
| System Admin | `admin@certiflow.gov.in` | `SUPER_ADMIN` | Settings, users, audit logs, system health, demo reset |

Sample CSV files for testing atomic uploads are included in `demo-data/`:
- `demo-data/invalid-candidates.csv` (tests atomic rejection with row errors and 0 saved rows)
- `demo-data/valid-candidates.csv` (6 valid candidates)
- `demo-data/60-candidates.csv` (60 valid candidates triggering Quality Review)

---

## 5. Manual Migration, Seed, and Reset Commands (Docker)

Migrations and seeding run automatically via `migrate-and-seed`, and you can also trigger them explicitly at any time:

```bash
# Re-apply Prisma migrations
docker compose exec api npx prisma migrate deploy

# Seed only if database is empty
docker compose exec api node dist/seed/run.js --if-empty

# Reset and re-seed all demo data cleanly
docker compose exec api node dist/seed/run.js --reset
```

You can also reset demo data from the UI: sign in as **System Admin** → **Admin & Health** → **Reset Demo Data**.

### Stop & Clean Restart

```bash
# Stop containers (preserves database and certificate volumes)
docker compose down

# Stop containers AND delete volumes for a 100% blank re-run
docker compose down -v
docker compose up --build
```

---

## 6. Running Automated Tests

Automated integration, RBAC, atomic upload, concurrency, idempotency, cancellation, and escalation tests run via Vitest + Supertest against an isolated PostgreSQL database (`certiflow_test`):

```bash
# 1. Start the PostgreSQL container (if not already running)
docker compose up -d postgres

# 2. Create the isolated test database and apply migrations
docker compose exec postgres psql -U postgres -c "CREATE DATABASE certiflow_test;"
cd backend
npm install
cp .env.example .env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/certiflow_test" npx prisma migrate deploy

# 3. Execute the full test suite
npm test
```

---

## 7. Optional: Local Non-Docker Development

If you want to run Node.js directly on your host machine:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your PostgreSQL DATABASE_URL (and optionally REDIS_URL/RABBITMQ_URL)

cd backend && npm install && npx prisma migrate deploy && npm run db:seed:if-empty && npm run dev
# In a second terminal:
cd frontend && npm install && npm run dev
```

Frontend runs at `http://localhost:5173` and proxies `/api` and `/socket.io` to `http://localhost:4000`.

---

## Troubleshooting

- **Port already in use (`5432`, `6379`, `5672`, `3000`, or `4000`)**: If you already have a local PostgreSQL/Redis/RabbitMQ running on your machine, edit `POSTGRES_PORT`, `REDIS_PORT`, `RABBITMQ_PORT`, `FRONTEND_PORT`, or `API_PORT` in `.env` (for example `POSTGRES_PORT=55432`). Internal container-to-container networking is unaffected.
- **Docker Hub Push (`bhanuprasadk1`)**:
  ```bash
  docker login
  docker compose build
  docker compose push
  ```
