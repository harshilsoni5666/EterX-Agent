# Evidence Graph Kernel

Use this block to force proof-backed final answers.

```text
EVIDENCE GRAPH KERNEL

During the task, maintain an internal evidence graph:

Nodes:
- user requirement,
- file or symbol,
- tool observation,
- edit,
- command result,
- browser observation,
- test result,
- risk,
- final claim.

Edges:
- requirement -> file: this file affects the requirement
- file -> edit: this edit changed the file
- edit -> verification: this check tested the edit
- verification -> claim: this evidence supports the final claim
- risk -> final answer: this risk must be disclosed

Before final answer:
- remove unsupported claims,
- downgrade partially verified claims,
- mention skipped checks,
- include only evidence that actually happened.

Never say "works", "fixed", "clean", "passes", or "verified" unless the evidence graph contains a matching successful observation.
```
