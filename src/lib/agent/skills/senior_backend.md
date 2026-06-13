---
name: "senior-backend"
description: Use for backend API design, service implementation, authentication and authorization, database access, migrations, performance work, reliability hardening, and backend code review across Node.js, TypeScript, Python, Go, and similar service stacks.
---

# Senior Backend Engineer

Use this skill to build or review backend systems with production behavior in mind: correctness, security, reliability, observability, and maintainability.

## First Pass

1. Identify the runtime, framework, package manager, database, API style, auth model, and deployment target.
2. Read existing routes/controllers/services/models before proposing new structure.
3. Preserve the repo's conventions unless they are causing a concrete problem.
4. Treat migrations, auth, payments, data deletion, and background jobs as high-risk changes.
5. Verify with the narrowest useful checks available in the project.

## Useful Local Commands

Use what exists in the repository:

```bash
rg --files
rg -n "route|router|controller|handler|middleware|PrismaClient|typeorm|sequelize|mongoose|knex|passport|jwt|session"
npm test
npm run build
npm audit --audit-level=high
npx @stoplight/spectral-cli lint openapi.yaml
npx autocannon http://localhost:3000/health
```

Do not run load tests against production or third-party systems without explicit authorization. Prefer local or staging targets with known test data.

## API Design

- Model resources and actions before writing handlers.
- Validate inputs at the boundary and keep domain logic out of controllers.
- Return consistent error shapes with stable machine-readable codes.
- Use idempotency keys for retries on create/payment/order-like operations.
- Version contracts deliberately; do not break existing clients silently.
- Add OpenAPI or typed contract coverage when the project already uses it.

## Data And Migrations

- Understand access patterns before changing indexes or schemas.
- Make migrations reversible when practical and safe to run repeatedly.
- Avoid long locks on large tables; split backfills from schema changes.
- Keep transaction boundaries explicit.
- Prevent N+1 queries with batching, joins, or preloading.
- Protect tenant boundaries in every query path.

## Auth And Security

- Authenticate once at the boundary; authorize at the resource/action level.
- Store secrets in environment or secret managers, never source files.
- Pin JWT algorithms and validate issuer, audience, expiry, and key rotation behavior.
- Apply rate limits to login, password reset, invite, and write-heavy endpoints.
- Log security-relevant events without printing secrets or tokens.

## Reliability

- Set timeouts for outbound calls.
- Retry only idempotent operations or operations with dedupe keys.
- Use dead-letter queues or failure tables for background jobs.
- Emit structured logs with correlation/request IDs.
- Add health/readiness checks that reflect real dependencies.

## Review Output

For backend reviews, report:

- Critical correctness or security issues first.
- Contract and migration risks.
- Performance bottlenecks with evidence.
- Missing tests or observability.
- Specific, minimal changes that fit the existing codebase.
