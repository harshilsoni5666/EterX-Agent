# Swarm runtime

Swarm Mode adds deliberate coordination to the existing agent runtime. It is a per-chat composer choice, alongside Plan mode, with a Lucide Network icon. Both modes can be enabled together. The composer stores the choice, sends it with new runs, and updates the live runtime through the authenticated mode endpoint. Failed updates restore the previous composer state.

Ordinary delegation remains available according to the chat's settings and request. Swarm Mode explicitly authorizes delegation and asks the model to design useful independent outcomes. It requires a rationale and acceptance condition for each ordinary spawn assignment. A completion reminder catches a selected mode that was never used; the agent must delegate useful work or explain a genuine limitation. It must not manufacture busywork to satisfy a headcount.

## Responsibilities

- `swarm-coordinator.ts` owns atomic admission, lineage, task dependencies, resource claims, queue ordering, and task budgets.
- `roles/sub_agent.ts` owns isolated provider execution, capacity reservations, cancellation, child joins, direct worker conversations, and retained reports.
- `spawn_sub_agent` exposes spawn, graph, join, status, and collect operations through the existing tool surface. Existing specialist and explicit panel operations use the same bounded scheduler.
- `agent_communicate` provides targeted peer communication and parent routing. Lifecycle notifications are distinct from evidence.
- The native provider loops and the tool-enabled custom-agent loop receive child outcomes before completing. Configured custom-agent tool availability still applies; mode selection does not install missing tools or rewrite fixed flow graphs.
- The workspace agent list renders the existing worker conversations as a collapsible, searchable, virtualized hierarchy.

There are no required frontend/backend/reviewer departments. Agents choose outcomes from the task, uncertainty, dependencies, and shared resources. A worker can delegate a narrower outcome and remains responsible for integrating its children.

## Task contracts

An assignment accepts:

| Field | Meaning |
| --- | --- |
| `key` | Unique task key within the current run. |
| `dependsOn` | Task keys in the same batch or existing task IDs in this run. |
| `rationale` | Why another worker helps with this outcome. Required in Swarm Mode. |
| `acceptance` | Deliverable or evidence needed to complete the assignment. Required in Swarm Mode. |
| `resources` | Workspace-relative file/directory claims with `read` or `write` access. |
| `priority` | Scheduling preference from 0 through 10; age also contributes to ordering. |
| `provider`, `model`, `mode`, `thinkingLevel` | Existing optional model selection controls. |

For example, a parent that has already identified a real dependency can admit a small frontier:

```json
{
  "mode": "spawn",
  "tasks": [
    {
      "key": "event-contract",
      "name": "Event contract",
      "task": "Determine which event fields the importer requires and document the compatibility constraints.",
      "rationale": "The migration needs a precise compatibility contract before implementation.",
      "acceptance": "Return the required fields, relevant source locations, and unresolved ambiguities.",
      "resources": [{ "path": "src/importer", "access": "read" }]
    },
    {
      "key": "migration",
      "name": "Import migration",
      "task": "Implement the requested importer migration using the event-contract findings and inherited user constraints.",
      "rationale": "This bounded implementation can use the contract evidence without repeating its investigation.",
      "acceptance": "Return the implemented behavior, changed files, and any remaining limitations.",
      "dependsOn": ["event-contract"],
      "resources": [{ "path": "src/importer", "access": "write" }]
    }
  ]
}
```

The example illustrates ordering; it is not a recommended team for every importer change. Sequential work may be cheaper for one agent.

Admission resolves all identities before starting any worker. Unknown dependencies, self/ancestor waits, cycles, duplicate active task text, repeated keys, excess depth, and excess run budgets reject the entire frontier. Cycle detection includes the implicit requirement that a parent finishes after its children, which catches cross-branch deadlocks that explicit dependency edges alone would miss.

Dependencies become ready only after a completed task publishes usable result content. A failed, cancelled, blocked, or empty dependency blocks its consumers. A report's availability does not prove its assertions or its acceptance condition; parents still assess evidence and resolve disagreements.

## Execution and ownership

Tasks move through `queued`, `running`, and `waiting` to `completed`, `failed`, `cancelled`, or `blocked`. Readiness requires dependency evidence, available capacity, and compatible resource claims. Priority and queue age order eligible work. There is no timer-based status polling loop in the scheduler: capacity, graph transitions, cancellation, and released edit leases wake waiters.

Overlapping read claims can coexist. Any overlapping write claim serializes the affected tasks. Paths resolve through existing filesystem ancestors so common symlink aliases refer to the same resource. A child cannot widen a parent's declared scope. Omitting the child's resource list inherits that scope; an explicit empty list grants no file writes. Legacy assignments without any declared scope remain compatible.

`workspace_edit_file` checks ownership at policy admission and again inside the file transaction. Temporary edit leases also prevent a new worker from acquiring a resource while an existing edit is in flight. These claims coordinate cooperating tools; they are not an operating-system sandbox. Commands, network actions, and other side effects remain governed by their existing policies.

When a worker calls `join`, it lends its provider slot and resource claims to the queue. It waits for its own children, then reacquires capacity and claims before running more tools or synthesizing their evidence. This allows nested delegation even when the per-chat concurrency limit is one. Parents should retain useful local work, join when a dependency actually requires it, and use narrower claims when children can work independently.

Closing a branch cancels its unsettled descendants, aborts active provider requests, and wakes queued or paused work. Cancellation before provider startup still creates a retained result. A late provider answer cannot turn a cancelled task into a success. A provider that ends before receiving its required child outcomes produces a failure with its partial answer retained.

## Communication and evidence

Use `ask_parent` and `handoff_parent` for assignment scope, blockers, and integration. Use targeted peer messages for a concrete shared dependency. Ordinary broadcasts are rejected above 64 registered team members; critical team-wide updates remain available. Model-originated sends have a per-agent, per-run budget of 60 attempts per minute, duplicate suppression, and a 16,000-character body limit. These controls reduce redundant traffic; they do not estimate the quality of a message.

Worker final reports automatically go to the delegating parent. Mailboxes are bounded notification history, so completion also reads the retained task graph. Before a parent finishes, up to 12 previously unsurfaced direct-child outcomes are delivered at a time, sharing a 24,000-character excerpt budget. Further pages are surfaced at subsequent completion boundaries. This prevents mailbox turnover from silently hiding a child's final outcome. Surfacing a report is not a claim that its contents have been independently verified.

`collect` is a snapshot; `join` is a wait barrier. Both return bounded pages. Collection selects the branch or page before marking reports collected, and exact task IDs disambiguate reused display names. Long reports expose `nextResultOffset`; pass that value as `resultOffset` with the exact `agentId` to continue reading. The returned page is explicitly identified, so a successful page is not presented as evidence for an entire large run.

Reports are atomically saved under the agents storage directory in `results/<project>/<task-id>.json`. Memory eviction only removes reports with a saved disk copy, preferring collected reports. A disk-write failure leaves the report in memory with a retention error instead of silently losing it. Exact-ID collection can recover saved reports after memory eviction or process restart. A later direct conversation with the same worker replaces that task's latest retained report; this is not a versioned event journal.

The graph, provider executions, capacity reservations, and edit claims are process-local. Restarting the process does not resume an interrupted swarm. This implementation is not a distributed scheduler or a crash-replay engine. Persisted reports and existing conversation persistence are recovery aids, not proof that interrupted work completed.

## Limits and scaling decisions

| Budget | Current limit |
| --- | --- |
| Admitted tasks in one run | 1,024, including descendants and terminal tasks |
| Recursive delegation depth | 8 worker levels |
| Tasks in one spawn call | 64 |
| Assignment text in one frontier / run | 256,000 / 2,000,000 characters, including rationale, acceptance, key, and resource paths |
| Concurrent workers per chat | Existing setting, 1–20; default 5 |
| Concurrent worker reservations in the process | 64 |
| Graph page | Default 50, maximum 100 |
| Status, collect, or join page | Default 20, maximum 100 |
| Report payload per collection page | 48,000 characters shared across reports |
| Retained report memory target | 1,024 per chat; 4,096 total, with unsaved reports protected |

These are admission and resource limits, not demonstrated throughput. A thousand-node graph does not imply a thousand simultaneous provider calls. Saved result archives remain until cleared; they are not subject to an automatic disk quota here. Clearing is refused while background work is active and preserves task-budget accounting so it cannot reset a run's expansion limit.

Queue, execution, and child-wait timing are exposed as accumulated worker time. They do not measure wall-clock speedup, answer quality, or model learning. Team expansion should follow newly discovered independent work, not unused capacity. Excessive overlapping claims intentionally serialize work; narrower assignments or direct execution may be more effective.

The runtime does not train LoRA adapters, mutate model weights, or claim an evolutionary optimizer. It improves orchestration of the existing models and provider infrastructure.

## Plan mode

The pinned selection reaches the execution context, and live changes are applied at provider boundaries. Native provider loops create or reuse a visible plan before executing the request; children use their own conversation scope and delegated objective. Reusing an active plan re-emits its current visible state. Completed or failed plans can be regenerated for a new forced-plan request. Required-plan failures are surfaced instead of being swallowed by context-compaction recovery.

Turning Swarm Mode off restores the underlying delegation setting at native provider boundaries, including descendants, while already-admitted work retains its lifecycle. Turning either mode off does not erase work or reports.

## Implementation status

### Context delivery and worker isolation

The October 13 context investigation found an actual payload blowup, not a million-token display unit error. In the saved UI-lineage worker run, two terminal searches produced 5,616,679 and 25,468,681 characters. Both requested a 24,000-character response, but `outputKind="read"` bypassed the terminal limit and every read-result/batch compactor. The next local context estimate was 8,471,638 tokens; the last provider-reported input was 20,890 tokens.

Terminal reads now retain their exact chronological output on disk and deliver bounded verbatim pages. `maxOutputChars` applies to reads as well as logs; the default is 24,000 characters, capped further at 8% of the active window using the existing four-character token estimate. `hasMoreOutput`, `outputStart`, `outputEnd`, and `nextOutputOffset` describe delivery, independently of process completion. Use `workspace_run_command` with `mode="check"`, the original `taskId`, and `sinceOffset=outputEnd` to continue. A completed command may still have unread pages. Disk/read failures are explicitly marked incomplete. Saved read output can be paged after a process restart without loading the entire file into the tool response.

Terminal command batches share a response allowance. Provider tool batches also account for read results, including JSON escaping, and preserve continuation handles when further reductions are needed. `context_memory open` defaults to bounded pages as well, so recalling a large archive cannot immediately refill the context. Exact original output is not a model summary; unread pages must not be treated as inspected evidence.

Live terminal buffers and UI snapshots are bounded for all output kinds. Subprocess streams pause when pending disk output grows too large and resume as it drains. This bounds working buffers; exact read archives remain subject to available disk space.

Each worker copies mutable compaction settings before execution, preserving policy isolation across model switches, descendants, and direct continuations. Parent force-compaction flags do not transfer to new children. Custom-agent tools receive the same context policy. Compaction terminal events may still pass through cancellation so a worker's notice can settle. The feed and composer label preflight counts as estimates and distinguish cancelled compaction from failure. A failed recovery whose retained payload is still above the active model's capacity stops before another provider submission; the original context is preserved.

This change was made without Git commands, builds, type checks, lint, automated tests, or runtime/UI checks, as requested. The limits above describe the implementation; no load, throughput, or production-readiness claim is made.
