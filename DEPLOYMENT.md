# CertiFlow — Production Deployment & Scaling Architecture

> **Important Disclaimer:** The Docker Compose stack in this repository is built for **hackathon demonstration and local development**. It is **not** production-ready as-is (single-node containers, local volume PDF storage, demo mode enabled, default local credentials). This document specifies the production architecture required to safely run Pragati Skills Mission at state/national scale.

---

## 1. Target Production Scale & Traffic Profile

| Metric | Production Target | Derived Load |
|---|---|---|
| Total Registered Users | 100,000 | ~150 MB user/session tables |
| Daily Active Users (DAU) | 10,000 | Peak ~1,500–2,500 concurrent users (business hours + result announcements) |
| Batch Submissions | 500 batches / hour | ~0.14 batches/sec steady; 5–10× burst near exam deadlines |
| Certificate PDFs + WhatsApp Jobs | 30,000 / hour (~60 candidates/batch) | **~8.3 certs/sec average**, **40–60 certs/sec burst** |
| Public Verification | Unbounded external bursts | Read-heavy, spike-prone during placement drives |

---

## 2. Production Reference Architecture

```
                        ┌─────────────────────────────┐
                        │  CDN / WAF (Cloudflare /    │
                        │  CloudFront + AWS WAF)      │
                        └──────┬──────────────┬───────┘
                               │              │
                  Static SPA   ▼              ▼  /api/* & /socket.io/*
                   ┌────────────────┐  ┌─────────────────────────┐
                   │ Object Storage │  │ L7 Load Balancer (ALB)  │
                   │ (S3 / GCS)     │  │ TLS 1.3 + Sticky WS     │
                   └────────────────┘  └────────────┬────────────┘
                                                    │
                    ┌───────────────────────────────┼───────────────────────────────┐
                    ▼                               ▼                               ▼
          ┌──────────────────┐            ┌──────────────────┐            ┌──────────────────┐
          │ API Pod (HPA)    │            │ API Pod (HPA)    │            │ Public Verify    │
          │ Express+SocketIO │            │ Express+SocketIO │            │ Read-Replica Pod │
          └───────┬──────────┘            └────────┬─────────┘            └────────┬─────────┘
                  │                                │                               │
        ┌─────────┴──────────────┬─────────────────┴───────────┐                   │
        ▼                        ▼                             ▼                   ▼
┌───────────────┐      ┌──────────────────┐          ┌───────────────────┐  ┌──────────────┐
│ Redis Cluster │      │ PostgreSQL 17    │─────────►│ PG Read Replicas  │◄─┘              │
│ (Socket.IO    │      │ Primary (Multi-AZ│  async   │ (Dashboards,      │                 │
│  adapter +    │      │ + PgBouncer)     │  stream  │  Public Verify*)  │                 │
│  rate limits) │      └────────┬─────────┘          └───────────────────┘                 │
└───────────────┘               │                                                          │
                                │ Outbox Publisher (2+ replicas, SKIP LOCKED)              │
                                ▼                                                          │
                     ┌─────────────────────┐                                               │
                     │ RabbitMQ Cluster    │ (3-node Quorum Queues + DLX)                  │
                     └──┬───────────────┬──┘                                               │
                        │               │                                                  │
                        ▼               ▼                                                  │
            ┌───────────────────┐ ┌────────────────────┐                                   │
            │ Cert Workers (HPA)│ │ Delivery Workers   │                                   │
            │ KEDA on queue len │ │ (Rate-limited to   │                                   │
            │ Writes PDFs → S3  │ │  WA BSP quota)     │                                   │
            └─────────┬─────────┘ └─────────┬──────────┘                                   │
                      ▼                     ▼                                              │
            ┌───────────────────┐ ┌────────────────────┐                                   │
            │ Encrypted S3/GCS  │ │ WhatsApp Business  │                                   │
            │ (SSE-KMS, private)│ │ API / BSP Webhook  │                                   │
            └───────────────────┘ └────────────────────┘                                   │
```

*\*Note on Public Verification consistency:* Cancellations MUST reflect immediately. Either route `/api/public/verify/:token` to the **PostgreSQL Primary** via PgBouncer (tiny indexed PK/unique lookup: < 2 ms, handles > 5,000 RPS easily) OR use synchronous replication / an event-invalidated negative revocation table on primary. Never serve cancellation status from a TTL-based Redis cache.

---

## 3. Component-by-Component Hosting Strategy

### Frontend Hosting
- Build the Vite SPA into immutable content-hashed assets and deploy to **S3 + CloudFront** (or **Cloudflare Pages / GCS + Cloud CDN**).
- Configure strict CSP, HSTS, `X-Frame-Options: DENY`, and long-lived caching for `/assets/*` with `no-cache` on `index.html`.

### API Hosting & Horizontal Scaling
- Containerized Node.js pods (`bhanuprasadk1/certiflow-backend`) on **Kubernetes (EKS/GKE)** or **ECS Fargate**.
- Minimum 3 replicas across 2–3 Availability Zones.
- Attach `@socket.io/redis-adapter` backed by Redis so real-time events broadcast across all API replicas.
- Autoscale (HPA) on CPU (65%) and event-loop lag / request latency (p95 > 250 ms).

### PostgreSQL
- Managed **Amazon RDS PostgreSQL 17 Multi-AZ** or **Cloud SQL HA** (`db.m6g.xlarge` or `db.r6g.xlarge`: 4–8 vCPU, 16–32 GB RAM, GP3 SSD with 6,000+ IOPS).
- Place **PgBouncer** (transaction pooling mode) in front of PostgreSQL so hundreds of API + worker connections multiplex onto ~80–120 backend DB connections.
- Partition `AuditLog` and `OutboxEvent` monthly once row counts exceed 10M; archive published `OutboxEvent` rows older than 7 days to cold storage.

### Redis
- Managed **ElastiCache / Memorystore Redis** (replication group with Multi-AZ failover).
- Used exclusively for: distributed rate-limit counters (`rate-limit-redis`), Socket.IO pub/sub adapter, and optional short-lived dashboard aggregation caches (never authoritative certificate state).

### RabbitMQ
- Managed **Amazon MQ for RabbitMQ** or 3-node Kubernetes RabbitMQ cluster using **Quorum Queues** (replicated across nodes for zero message loss on broker failure).
- Separate vhost, TLS (`amqps://`), dedicated per-queue dead-letter queues (`*.dlq`), and publisher confirms enabled.

### Object Storage for PDFs
- Replace local disk (`./storage/certificates`) with **private S3 / GCS bucket** encrypted with SSE-KMS.
- Keep `Block Public Access` enabled. API authorizes the requesting user against `certificateScope(user)` and either streams the object or issues a **60-second pre-signed URL** (and blocks immediately if `certificate.status === 'CANCELLED'`).

---

## 4. Scaling Workers & Queue Backlog Management (30,000 Certs/Hour)

Let's size for **30,000 certificates/hour** (~8.3/sec average) with **5× bursty traffic** (~42/sec peak):

1. **PDF Generation (`certificate-worker`)**:
   - Each PDFKit + QR render takes ~40–60 ms of CPU (~18 PDFs/sec per vCPU core).
   - **Baseline**: 2 worker replicas (1 vCPU each) comfortably sustain ~35 PDFs/sec (>120,000/hour).
   - **Burst handling**: Configure **KEDA** to scale `certificate-worker` from 2 → 12 replicas based on `cf.certificate.generate` queue depth (> 50 messages/replica).
   - **Optimization**: Split `batch.state.approved` into per-candidate (or 10-candidate chunk) messages at very large batch sizes (500+ candidates) so one worker never monopolizes a large batch and retries stay granular.

2. **WhatsApp Delivery (`delivery-worker`)**:
   - External WhatsApp BSP APIs enforce strict throughput limits (typically 80–250 msg/sec per Business Account).
   - Configure RabbitMQ `prefetch` (e.g., 20) + token-bucket rate limiter per BSP tier so bursts smooth cleanly inside RabbitMQ instead of triggering `429 Too Many Requests`.
   - Use **exponential backoff with jitter** (`10s → 30s → 2m → 10m → 1h`) and route exhausted jobs to `cf.whatsapp.delivery.dlq` with alerting.
   - Maintain a **separate queue** for manual retries vs automated first attempts so large retry waves never starve fresh issuances.

3. **Outbox Publisher & Escalation Scheduler**:
   - `outbox-publisher` uses `SELECT ... FOR UPDATE SKIP LOCKED`, allowing 2+ HA replicas with zero duplicate claims.
   - `scheduler` runs with a PostgreSQL advisory lock or Kubernetes `CronJob` (`concurrencyPolicy: Forbid`) plus DB unique constraints on `(batchId, version, stage)`.

---

## 5. Failure Recovery, Monitoring & Alerting

### Failure Scenarios & Recovery
- **RabbitMQ outage**: Business transactions continue committing to PostgreSQL `OutboxEvent`. When RabbitMQ recovers, `outbox-publisher` drains the backlog automatically with zero lost events.
- **Worker crash mid-job**: Unacknowledged AMQP messages redeliver automatically; stale `DeliveryJob` locks (`PROCESSING` > 2 min) are reclaimed by the sweep; all DB writes are idempotent via unique constraints.
- **Database failover**: Multi-AZ RDS promotes standby in ~30–60s; Prisma + PgBouncer reconnect automatically; outbox + RabbitMQ retries absorb the transient error window.

### Monitoring & Alerting (Prometheus + Grafana + OpenTelemetry)
Alert thresholds to configure:
- **Critical (PagerDuty)**:
  - API 5xx rate > 1% for 2 min
  - PostgreSQL connections > 85% or replication lag > 5s
  - `OutboxEvent` `PENDING` age > 60s or `FAILED` count > 0
  - Any messages entering `*.dlq`
  - Public verification p95 latency > 300 ms
- **Warning (Slack/Ops)**:
  - Queue depth `cf.certificate.generate` > 500 or `cf.whatsapp.delivery` > 5,000
  - Delivery failure rate > 10% over 10 min
  - Open batch escalations > 10

---

## 6. Security Hardening Checklist for Production

- Disable `DEMO_MODE=false` and remove demo seed accounts.
- Rotate `JWT_ACCESS_SECRET` via AWS Secrets Manager / Vault; set `COOKIE_SECURE=true` and `SameSite=Strict` or `Lax` over HTTPS-only.
- Enforce WAF rules (OWASP Core Rule Set) + bot protection on `/api/public/verify/*` and `/api/auth/login`.
- Enable PostgreSQL TLS (`sslmode=verify-full`) and private VPC subnets (no public DB/Redis/RabbitMQ ports).
- Run periodic dependency scanning (`npm audit`, Trivy container scans) in CI/CD before pushing images to Docker Hub (`bhanuprasadk1/*`).

---

## 7. Backup & Restore Strategy

- **PostgreSQL**: Automated daily snapshots retained 35 days + continuous WAL archiving for **Point-in-Time Recovery (PITR)** to any second (RPO < 1 min, RTO < 15 min). Quarterly restore drills into a staging VPC.
- **Object Storage (PDFs)**: Enable S3 Versioning + Cross-Region Replication (CRR). Note that PDFs are also deterministically regenerable from PostgreSQL certificate records if ever required.
- **Audit Logs**: Stream immutable `AuditLog` snapshots nightly to WORM storage (S3 Object Lock in Compliance mode) for multi-year government audit retention.

---

## 8. Cost Tradeoffs (Estimated Monthly Cloud Spend)

| Tier | Infrastructure | Est. Monthly Cost | Suitable For |
|---|---|---|---|
| **Pilot / Single State** | 2× small API/worker nodes, Single-AZ RDS `db.t4g.medium`, Redis micro, Managed RabbitMQ single broker, S3 | ~\$250 – \$450 / mo | Up to 10K users, 5K certs/hr |
| **Production Target (100K users, 30K certs/hr)** | EKS/ECS (3 API + 2–8 autoscaled workers), Multi-AZ RDS `db.r6g.large` + 1 Read Replica, Multi-AZ Redis, 3-node RabbitMQ, S3 + CloudFront + WAF | ~\$1,200 – \$2,000 / mo | 100K users, 10K DAU, 30K certs/hr with 5× bursts |
| **High-Compliance National Scale** | Multi-region active-passive, RDS `db.r6g.2xlarge`, dedicated WAF/Shield, SOC2/CERT-In SIEM logging | ~\$4,500+ / mo | 1M+ users, multi-state federation |

**Primary Cost Lever**: Scaling workers dynamically with KEDA (scale-to-2 off-peak, scale-to-12 during batch bursts) avoids paying 24/7 for peak PDF rendering CPU while keeping batch issuance latency under 60 seconds.
