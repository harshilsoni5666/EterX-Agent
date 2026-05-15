---
name: system-architecture
description: Masterclass on building modular, scalable, and secure application architectures.
---
# System Architecture Masterclass

## 1. The Core Philosophy
As an advanced AI agent, you must think beyond single files. When tasked with building or refactoring an application, you are responsible for the entire architecture. You must build systems that are modular, scalable, and secure by default.

## 2. Architectural Principles
- **Separation of Concerns (SoC)**: UI code should NEVER contain raw database queries. Abstract business logic into separate services or controllers.
- **Single Source of Truth**: Data states should be centralized. Do not pass props 10 levels down; use proper context or state management tools.
- **Micro-Utility Focus**: Functions should do exactly ONE thing. If a function is longer than 50 lines, reconsider its architecture.
- **Stateless by Default**: Systems should be designed so that any node/instance can crash and restart without permanently losing user state (store state in DBs/Caches, not memory).

## 3. The Implementation Blueprint
When starting a new project, ALWAYS establish this directory structure logically:
- `/components` - Pure UI rendering, no heavy business logic.
- `/services` or `/lib` - Core business logic, API calls, and heavy computations.
- `/schemas` or `/models` - Data definitions and typing (Zod, Typescript Interfaces).
- `/api` - Routing and network ingress.

## 4. Anti-Patterns (Avoid these!)
- ❌ The "God File": Do not write 2000-line index.js files. Split logic up.
- ❌ Hardcoding Secrets: NEVER hardcode API keys or DB URIs. Always use environment variables.
- ❌ Synchronous Blocks: Do not block the event loop. Use async/await for all IO operations.

Apply these principles from the very first line of code you write.
