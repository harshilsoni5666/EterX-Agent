# Local Skill Library

This folder is the isolated, project-owned skill set for the EterX agent.
It is intentionally separate from the older skill directory and from machine-wide skill installations.

## What a skill is

A skill is a small Markdown instruction module that gives the agent reliable behavior for one kind of work. A good skill tells the agent:

1. when it applies;
2. what inputs or evidence to inspect;
3. what workflow to follow;
4. how to verify the result; and
5. what completion looks like.

Skills are guidance, not executable permissions. They must not hide actions, invent tools, expose credentials, or perform destructive work without authorization.

## How to write one

Create one Markdown file with this frontmatter:

```yaml
---
name: short-kebab-case-name
description: State the trigger, purpose, and main boundary in one or two sentences.
category: documents
icon: FileText
---
```

Then keep the body focused:

- define the decision boundary;
- name the evidence to inspect;
- give a short, ordered workflow;
- state safe defaults and important exceptions;
- finish with checks that can actually run locally.

Use the same concept in the file name and `name`. Do not duplicate another skill, reference unavailable paths, or include platform-specific branding. If two skills overlap, keep the clearer one and remove the weaker one.

## Included skills

- `docx`: Word documents and structured written artifacts
- `pdf`: fixed-layout PDF creation, extraction, forms, conversion, and QA
- `pptx`: editable presentation creation and verification
- `xlsx`: spreadsheet modeling, analysis, and workbook QA
- `image-generation`: bitmap image generation and editing guidance
- `visualization`: charts, diagrams, and interactive explainers
- `template-creator`: reusable artifact-template creation
- `skill-creator`: skill design, review, repair, and consolidation
- `connector-setup-and-mcp-operations`: authorized connector and tool setup

The browser/search and product-documentation modules are deliberately not part of this isolated set.
