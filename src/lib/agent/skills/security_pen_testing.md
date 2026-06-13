---
name: "security-pen-testing"
description: Use for authorized security review, vulnerability triage, OWASP checks, dependency scanning, secret detection, API security review, local exploitability validation, remediation planning, and professional security findings reports.
---

# Security Penetration Testing

Use this skill only for systems the user owns or is explicitly authorized to assess. Prefer source review, dependency analysis, configuration review, local test environments, and non-destructive verification.

## Scope Rules

- Confirm the target, authorization, environment, and excluded systems before active testing.
- Stay within local repositories, provided artifacts, staging systems, or explicitly approved assets.
- Do not access real user data, secrets, third-party systems, or production targets unless the user has given clear authorization and scope.
- Use proof-of-concept validation only to the minimum extent needed to confirm impact.
- Keep evidence secure and redact tokens, cookies, credentials, personal data, and sensitive business data.

## Review Workflow

1. Map the application: routes, auth flows, roles, data stores, background jobs, external integrations, deployment config.
2. Build an OWASP-oriented checklist from the actual architecture.
3. Run available safe scans: dependency audit, secret scan, static analysis, IaC/container checks, test suite security checks.
4. Review high-risk code paths manually: auth, authorization, file handling, deserialization, rendering, payments, admin functions, webhooks.
5. Validate findings with safe local tests when possible.
6. Write findings with evidence, impact, affected assets, remediation, owner, and verification steps.

## Areas To Check

| Area | Examples |
|---|---|
| Access control | IDOR/BOLA, vertical privilege escalation, tenant isolation, admin-only endpoints |
| Authentication | Session fixation, token expiry, refresh handling, cookie flags, password reset flow |
| Injection | SQL/NoSQL/command/template injection, XSS, unsafe DOM sinks |
| Cryptography | Weak hashing, hardcoded keys, unsafe randomness, TLS policy, key rotation |
| Configuration | Debug mode, permissive CORS, missing security headers, exposed admin surfaces |
| Dependencies | Known CVEs, abandoned packages, vulnerable transitive dependencies |
| Secrets | Hardcoded credentials, committed keys, unsafe logs, environment leaks |
| SSRF/file handling | URL allowlists, private-network protection, path normalization, upload validation |
| Integrity | Unsafe deserialization, missing webhook signature verification, CI/CD trust gaps |
| Logging/monitoring | Missing auth logs, sensitive logs, weak alerting, no audit trail |

## Useful Commands

Use commands that fit the detected stack and are already acceptable for the environment:

```bash
npm audit --audit-level=high
pip audit
govulncheck ./...
bundle audit check
```

For secret scanning, prefer installed tools such as Gitleaks or TruffleHog. If they are unavailable, use scoped repository searches for credential patterns and verify suspected findings manually without exposing secret values.

## API Security

- Verify every object read/write checks the authenticated principal and tenant.
- Add negative tests that regular users receive 403 for protected resources.
- Check mass-assignment risk on update/create handlers.
- Validate rate limits and lockouts with bounded local tests.
- For GraphQL, check query depth, cost limits, batching, and introspection policy.

## Web Security

- XSS: inspect untrusted rendering paths, sanitizer use, framework escape hatches, markdown/HTML rendering, and DOM sinks.
- CSRF: check token validation, SameSite cookie attributes, unsafe method protection, and origin checks.
- SSRF: check URL parsing, redirects, DNS rebinding protections, and private network blocks.
- File upload/path handling: check MIME validation, extension handling, storage path normalization, scanning, and public access.

## Findings Report

Use this structure for each finding:

```text
Title:
Severity:
Affected asset:
Evidence:
Impact:
Reproduction or validation:
Remediation:
Verification:
References:
```

Severity should reflect exploitability, impact, exposure, privilege required, affected data, and compensating controls.

## Disclosure

For third-party or shared systems, follow the owner program's rules of engagement, bug bounty policy, or responsible disclosure process. If no process exists, recommend private reporting with encrypted communication, a clear remediation window, and no public details until the owner has had a reasonable chance to fix.

## Related Skills

Use local skills when they fit the task:

| Skill | Relationship |
|---|---|
| security_auditor | Defensive code, dependency, configuration, and secret review |
| code_review | Security-sensitive change review |
| senior_backend | API design, auth, rate limiting, and service hardening |
| docker_development | Container image, compose, and runtime security |
| devops | Deployment, infrastructure, backup, and rollback safety |
