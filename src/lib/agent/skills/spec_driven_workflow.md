---
name: "spec-driven-workflow"
description: Use when the user wants a spec, acceptance criteria, feature plan, implementation contract, test plan, or spec-first workflow before coding.
---

# Spec-Driven Workflow

Use specs to reduce ambiguity before implementation. This skill is strongest for nontrivial features, cross-team work, risky changes, or anything with unclear acceptance criteria. It is not meant to block tiny obvious fixes.

## When To Use

- New feature or workflow.
- Public API/schema change.
- Security, billing, auth, data migration, or compliance-sensitive work.
- Work that needs acceptance criteria before coding.
- User explicitly asks for spec-first planning.

## Spec Shape

Adapt the sections to the task:

- Title, owner, status, date.
- Context and problem.
- Goals and non-goals.
- Users and primary journeys.
- Functional requirements.
- Non-functional requirements: performance, accessibility, security, reliability, privacy.
- Acceptance criteria in testable language.
- Edge cases and failure modes.
- API/data model changes when relevant.
- Rollout, migration, and rollback.
- Open questions and decisions.

Small specs can be one page. Large specs can be deeper.

## Acceptance Criteria

Good criteria are observable:

```gherkin
Given [initial state]
When [user/system action]
Then [observable result]
```

Every important requirement should have at least one acceptance criterion. Avoid subjective wording like "fast", "nice", or "easy" unless it is paired with measurable evidence.

## Autonomy Rules

Proceed when requirements are clear and changes are local.

Stop or ask when:

- Scope changes beyond the spec.
- Public API, schema, auth, billing, PII, or production behavior changes are required.
- Performance targets are stated but cannot be measured.
- A missing decision would lead to incompatible implementations.

When asking, provide options and a recommendation.

## Implementation Handoff

Before coding from a spec:

- Map requirements to tests.
- Identify files/modules likely touched.
- Define verification commands.
- Note migration/rollback risks.
- Keep implementation within the agreed scope unless the spec is updated.

## Review Checklist

- Requirements are atomic and testable.
- Acceptance criteria cover happy path and key failures.
- Out-of-scope items are explicit.
- Data/API contracts are clear where relevant.
- Verification plan is realistic for this repo.
- Open questions are few and actionable.
