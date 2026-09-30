# Conversation intent and live steering

The effective request is the current outcome plus compatible requirements,
scoped permissions, completed work, pending work, and subsequent human changes.
The original prompt and the latest message are inputs to that state; neither
alone describes the entire task.

`conversation-intent-policy.ts` supplies the shared interpretation rules to
context-aware provider loops and both supervising agents. Instruction authority
and scope come before recency. A later human correction replaces an earlier
choice in the same scope without requiring formal override language. Questions,
examples, additions, pauses, cancellations, and independent requests retain
their different meanings, including when several appear in one message.

The runtime now:

- Retains each human update as an ordered Context Fabric source, including
  individual messages delivered in one steering receipt. The latest-message
  slot no longer provides the only retained copy of earlier corrections.
- Labels original objectives as task anchors and extracted constraints as
  excerpts requiring source context. Stored `active` status is not proof that
  every clause remains binding or that a completed task must restart.
- Preserves human constraints, action evidence, pending work, and failures
  across heuristic task boundaries. A classifier cannot grant permission,
  erase completed actions, or declare an unobserved process successful.
- Separates a settled reply from an unsettled user request when routing the
  next turn. A question mark alone does not establish a pending user-input gate.
- Defers tools that have not started when a human update is waiting, both at
  batch dispatch and after asynchronous preparation. Each proposed tool keeps
  its provider result pairing. Already-started tools are not rolled back;
  their actual result remains evidence for the next decision.
- Refreshes plan context at provider boundaries and lets the effective request
  govern completion instead of forcing another iteration for stale plan items.
- Uses keyword skill matching for discovery rather than rejecting a model's
  skill choice based on the run's original prompt.
- Stops treating a finished reply as a positive memory-learning signal, or a
  user stop/provider failure as proof that recalled context was incorrect.
- Reads legacy request wrappers and removes their former “execute only this”
  instruction when restoring saved working context, preserving dialogue IDs,
  attachments, and tool exchanges.

Compaction records the effective choice and the replaced choice with their
source IDs. It must distinguish unverified work from required verification,
and retain a no-tests/no-checks instruction until the human changes its scope.
An original task, a supervisor suggestion, or a learned preference cannot
override a subsequent direct human correction.

Examples: switching the requested language preserves unrelated deliverable
requirements; asking for status during work does not discard the task; a color
revision after completion reuses the existing artifact; an unrelated new request
does not restart the old checklist; and “continue” does not expand authorization.

Natural-language interpretation remains a model responsibility. Boundary
heuristics are conservative routing hints, and these changes do not establish
perfect behavior. Automated checks and tests were not run for this change at
the user's request.
