# Memory and context continuity

The default runtime uses Context Fabric for chat history, observed actions,
pending work, and exact source pages. It also loads one bounded durable-memory
channel for explicit user preferences and project facts. The legacy reasoning
and memory injectors remain opt-in; enabling preferences does not reactivate
all of those systems.

## Durable preferences

- Automatic learning consumes the human request before provider context is
  assembled. Runtime-added pinned context is not a preference source.
- Statements are extracted individually. Temporary instructions, questions,
  quoted examples, and code blocks stay in chat history. A technology mention
  alone is not a preference. Project statements remain project-scoped.
- Recall matches the exact user identity. A missing project/chat identity is
  not a wildcard. Old project-continuity snapshots remain local to their chat.
- Retrieval searches full record content, including short technical words.
  Explicit user preferences can remain relevant when the topic changes.
- Exact duplicate records with the same owner, scope, chat, and source are not
  added again or treated as independent evidence.
- Context contains complete JSON records with source, scope, timestamp, and
  confidence. Both initial rendering and context federation omit whole records
  at the budget boundary; neither cuts a rule halfway through its negation.
- Preference inference is deliberately conservative. It is not a semantic
  contradiction resolver; current human instructions still settle conflicts.

Memory writes are serialized within the manager. A flush waits for an existing
write and drains mutations received during that write. Failure leaves the
changes pending. This is not a cross-process database transaction.

## Task and harness continuity

The harness imports ordered human directives from the active task's Context
Fabric. It restores execution preferences independently of tool evidence, so
continuing a task can preserve a declined-checks instruction without treating
old verification as proof of the current file state. Current instructions and
later live steering take precedence over earlier compatible task policy.

Constraint records from earlier steering remain eligible for the bounded
decision surface after newer messages arrive. Legacy working memory also keeps
goals and constraints from decaying merely because the latest observation uses
different words. Its bounded prompt retains whole records.

The orchestrator isolates cached hydration by user and project, keeps its
original freshness timestamp on cache hits, and preserves false/zero preference
values. A returned assistant response is stored as a response, not independently
verified task completion. Optional post-response persistence failures return
warnings without discarding that response.

## Compaction and feedback

Compaction coverage requires more than a copied fact ID. The audit considers
the fact's local entry, original source, epistemic status, text, and exact
values. Objectives, constraints, and pending next actions stay explicit. Other
bulky evidence can be deferred with its own page reference and an instruction
to open that page before relying on it. Missing records are restored with their
original authority and a reminder to reconcile later human corrections.

The exact-reference appendix ranks constraints, pending work, failure evidence,
and identifiers ahead of ordinary paths, preferring recent occurrences within
each class. Large early file listings therefore cannot consume the entire
anchor allowance. Exact transcript archives still retain the full source.

Compression feedback strengthens retention of the omitted fact kinds. It does
not penalize unrelated facts retrieved for the last query. This is runtime
memory-policy adaptation, not model-weight training or a measured improvement
in model intelligence.

No tests, build, lint, type checks, benchmarks, or Git operations were run for
this change, as requested. Runtime behavior and performance remain unverified.
