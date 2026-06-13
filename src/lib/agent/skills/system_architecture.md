---
name: system-architecture
description: Use for architecture design, refactoring boundaries, module decomposition, scalability, reliability, security, and long-term maintainability decisions.
icon: Network
category: coding
---

# System Architecture

Architect from current constraints, not generic diagrams.

## Workflow

1. Read the existing system shape: modules, data flow, boundaries, deployment, and constraints.
2. Identify the decision being made and what must remain compatible.
3. Compare options by correctness, simplicity, operability, security, cost, and migration risk.
4. Prefer small reversible steps over speculative rewrites.
5. Document the chosen boundary and the reason it exists.

## Principles

- Keep business logic out of UI-only components.
- Put IO, persistence, and external APIs behind explicit boundaries.
- Make data ownership clear.
- Design failure modes before happy-path scale.
- Avoid global state unless it is truly shared application state.
- Keep observability and rollback paths in the design.

## Deliverables

Use concise artifacts: module map, decision table, migration plan, risk list, or interface sketch. Do not create architecture theater when a small code change is enough.
