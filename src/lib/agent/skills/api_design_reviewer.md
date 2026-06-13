---
name: "api-design-reviewer"
description: Use when reviewing, designing, linting, or evolving HTTP APIs, REST APIs, OpenAPI/Swagger specs, endpoint contracts, API versioning, error formats, pagination, authentication, authorization, rate limits, or breaking changes.
---

# API Design Reviewer

Review API designs from the actual routes, handlers, schemas, OpenAPI files, client usage, and tests in the workspace. Do not rely on a generic checklist when source evidence is available.

## Review Workflow

1. Identify the API surface: route files, controllers, OpenAPI specs, generated clients, SDKs, tests, and docs.
2. Determine the audience and compatibility level: internal service, public API, partner API, mobile/backend contract, or generated client contract.
3. Check consistency across endpoints before judging individual routes.
4. Separate breaking changes from non-breaking improvements.
5. Recommend concrete edits to specs, handlers, docs, tests, and migration notes.
6. Run available validation commands when safe and relevant.

## Design Checks

| Area | What to verify |
|---|---|
| Resource model | Noun-based resources, consistent nesting, clear ownership boundaries |
| Methods/status | Correct method semantics, idempotency, status codes, redirects, async operations |
| Request shape | Validation, required vs optional fields, enum growth, unknown-field behavior |
| Response shape | Stable envelope, sparse fields, nullability, timestamps, IDs, links when useful |
| Errors | Consistent error object, machine-readable codes, request IDs, safe messages |
| Pagination | Cursor/page/offset choice, stable ordering, limits, next tokens, total semantics |
| Filtering/sorting | Explicit supported operators, index-aware defaults, safe query limits |
| AuthN/AuthZ | Authentication scheme, object-level authorization, scopes, tenant boundaries |
| Versioning | URI/header/media strategy, deprecation policy, migration path |
| Performance | Caching, ETags, compression, batch endpoints, N+1 risk, payload size |
| Observability | Request IDs, audit events, metrics, useful logs without secrets |
| Documentation | Examples, schemas, auth docs, error docs, changelog, SDK impact |

## Breaking Change Rules

Treat these as breaking unless the repository documents a different compatibility contract:

- Removing or renaming endpoints, fields, enum values, or status codes clients depend on.
- Making optional request fields required.
- Changing field type, nullability, precision, time zone, or ID format.
- Changing pagination token semantics or sort order guarantees.
- Tightening validation in a way existing clients may fail.
- Changing auth requirements, scopes, tenant visibility, or rate limits.

Usually safe changes: adding optional request fields, adding response fields, adding endpoints, adding nullable fields, documenting an existing behavior, and adding stricter server-side protections that do not reject valid existing clients.

## Useful Tooling

Prefer tools already configured in the repo. Common options:

```bash
npx @stoplight/spectral-cli lint openapi.json
npx @redocly/cli lint openapi.json
npx openapi-diff openapi-v1.json openapi-v2.json
```

Also use the project test runner for contract tests, generated-client tests, handler integration tests, and authorization regression tests.

## Output Format

Lead with findings, ordered by severity:

```text
[P1] Breaking response change in GET /api/v1/orders
Evidence: openapi-v2.json removes order.total.currency; mobile client reads it in ...
Impact: Existing clients can fail or display totals incorrectly.
Recommendation: Keep the field through v1, add replacement field as optional, document deprecation, and add a contract test.
```

Then include:

- Open questions or assumptions.
- Commands/checks run and results.
- Suggested next edits or migration plan.
