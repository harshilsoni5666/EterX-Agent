---
name: "docker-development"
description: Use for Dockerfile optimization, docker-compose design, multi-stage builds, image-size reduction, BuildKit usage, container security, health checks, runtime configuration, and containerized development workflows.
---

# Docker Development

Use this skill to make containers smaller, safer, faster to build, and easier to operate. Keep changes grounded in the existing app and deployment model.

## First Pass

1. Inspect existing `Dockerfile`, `docker-compose.yml`, `.dockerignore`, package manifests, lockfiles, build scripts, and deployment docs.
2. Identify the runtime and build system before proposing a base image.
3. Preserve developer workflow unless the user asked for a redesign.
4. Prefer reproducible builds: pinned base images, lockfile installs, deterministic build steps.
5. Explain risks before privileged containers, host networking, broad mounts, or production-impacting changes.

## Dockerfile Standards

- Install dependencies before copying the full source tree to preserve layer cache.
- Use multi-stage builds when build tools are not needed at runtime.
- Run as a non-root user in runtime images.
- Keep `.dockerignore` tight: VCS files, local dependencies, build outputs, logs, secrets, and caches.
- Do not bake secrets into `ARG`, `ENV`, image layers, or compose files.
- Add health checks when the orchestrator uses them.
- Clean package-manager caches in the same layer where packages are installed.

## Compose Standards

- Separate app, database, cache, queue, and worker services clearly.
- Use named volumes for persistent local data.
- Scope exposed ports to what developers actually need.
- Put local-only settings in compose overrides or env files.
- Keep production secrets out of compose files.
- Add dependency readiness through health checks where possible; `depends_on` alone is not readiness.

## Security Review

Check for:

- Root runtime user.
- Latest/floating base tags.
- Unnecessary shell tools in runtime image.
- Broad Linux capabilities or privileged mode.
- Host mounts of sensitive paths.
- Secret leakage through build args, env vars, logs, image history, or copied files.
- Unpatched OS packages and vulnerable language dependencies.

## Useful Commands

```bash
docker build -t app:local .
docker run --rm app:local
docker image ls
docker history app:local
docker compose config
docker compose up --build
docker scout cves app:local
```

Use commands that exist in the environment. Do not run destructive cleanup against shared Docker state unless the user asked for it.

## Output

For Docker work, return:

- What changed and why.
- Build/runtime/security risks addressed.
- Commands run and results.
- Remaining manual deployment or secret-configuration steps.
