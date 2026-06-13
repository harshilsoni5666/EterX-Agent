---
name: skill-creator
description: Create, review, repair, consolidate, or improve EterX markdown skills. Use when the user asks to add a skill, edit skill instructions, fix skill routing, remove duplicate/weak skills, design metadata, or evaluate whether skills are useful and safe.
category: core
icon: Wrench
---

# Skill Creator

Use this skill to make the EterX skill system lean, safe, and reliable.

## Skill Standard

Every skill must answer five questions:

1. **When should it trigger?** Put concrete trigger contexts in frontmatter `description`.
2. **What evidence should it gather?** Name the real files, inputs, state, or outputs to inspect.
3. **What workflow should it follow?** Keep steps procedural and short.
4. **How should it validate?** Include checks that can actually run in the current runtime.
5. **What should the final output contain?** Make completion criteria observable.

## Required Frontmatter

```yaml
---
name: skill-name
description: Clear trigger and purpose in one or two sentences.
category: coding | design | data | documents | security | ops | core
icon: LucideIconName
---
```

Use lowercase kebab-case for `name`. Avoid spaces, punctuation-heavy names, and aliases that do not match the file name. Keep IDs stable by naming files with the same concept, for example `skill_name.md` for `skill-name`.

## Authoring Rules

- Prefer one focused skill over a broad motivational prompt.
- Remove stale platform names, unavailable tools, missing local paths, and instructions that assume another product runtime.
- Do not reference bundled `scripts/`, `references/`, `assets/`, `resources/`, or `workflows/` unless those files actually exist.
- Do not add hidden automation, exfiltration behavior, credential handling, destructive actions, or surprise network activity.
- Use real project tools and local conventions instead of imaginary tool names.
- Keep examples short and safe; avoid exploit payloads, access-circumvention language, or fake secrets.
- If a skill overlaps heavily with another, consolidate or delete the weaker one.

## Review Workflow

1. Inventory the candidate skill files and loaded registry IDs.
2. Classify each skill as useful/good, useful-but-needs-change, duplicate/weak, or removal candidate.
3. Check frontmatter: `name`, `description`, optional `category`, optional `icon`.
4. Search for broken references, stale product names, unsafe instructions, invented tools, and placeholder content.
5. Make the smallest edits that improve runtime behavior.
6. Run a loader smoke test and TypeScript check after TypeScript changes.

## Quality Bar

A production skill should be:

- **Specific:** It has clear trigger conditions and boundaries.
- **Grounded:** It tells the agent what to inspect before acting.
- **Executable:** It references only available tools or generic tool categories.
- **Safe:** It respects user authorization, credentials, destructive operations, and external systems.
- **Short:** It improves behavior without drowning the agent in boilerplate.

## Removal Criteria

Remove or merge a skill when it:

- Duplicates another skill with less detail.
- Mainly says “try harder” or “be excellent.”
- Depends on unavailable tools or another product’s runtime.
- Encourages unsafe autonomy, hidden git actions, browser evasion, or offensive activity.
- Adds more routing noise than useful behavior.
