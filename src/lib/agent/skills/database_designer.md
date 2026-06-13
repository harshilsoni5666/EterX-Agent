---
name: "database-designer"
description: Use when designing schemas, planning migrations, optimizing queries, choosing SQL vs NoSQL, modeling relationships, indexing, partitioning, or reviewing database changes.
---

# Database Designer

Design databases from access patterns, integrity requirements, and operational constraints.

## Workflow

1. Identify entities, relationships, reads, writes, transaction boundaries, and growth expectations.
2. Choose storage technology based on query shape, consistency needs, team skills, and operations.
3. Model schema with constraints before optimizing.
4. Add indexes for proven query patterns; avoid speculative index sprawl.
5. Plan migrations with rollback, backfill, lock risk, and compatibility.
6. Verify with realistic queries and data volumes when possible.

## Schema Checklist

- Clear table/entity names.
- Right-sized data types.
- Primary keys and foreign keys where relationships are enforced.
- Unique/check constraints for business invariants.
- Nullable fields justified.
- Audit fields where operationally useful.
- Tenant/user boundary fields where needed.

## Query And Index Checklist

- Use `EXPLAIN`/`EXPLAIN ANALYZE` for slow queries.
- Index foreign keys and high-selectivity filters used in common paths.
- Consider composite indexes in query predicate/order order.
- Watch for N+1 queries and unbounded scans.
- Remove redundant or unused indexes only with evidence.

## Migration Safety

- Prefer expand/contract for zero-downtime changes.
- Split schema change, backfill, and cleanup for large tables.
- Make migrations idempotent where practical.
- Test rollback or forward-fix strategy.
- Avoid destructive changes until consumers are migrated.

## Output

Return schema recommendations, migration plan, query/index changes, risks, and verification steps. Include SQL or ORM snippets only when they fit the user's stack.
