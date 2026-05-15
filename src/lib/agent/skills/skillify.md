---
name: Skillify
id: skillify
description: Create new reusable skills from workflows. Package common patterns into .md skill files that can be loaded by the agent.
icon: Wand2
category: coding
---

# Skillify - Create Custom Skills

Create new reusable skill files from coding workflows.

## Instructions

1. Identify a repeatable workflow or pattern
2. Create a .md skill file with frontmatter and instructions
3. Save to src/lib/agent/skills/
4. The skill will be auto-loaded on next restart

## Skill File Format

```markdown
---
name: Skill Name
id: skill_id
description: What the skill does
icon: IconName
category: coding
---

# Skill Name

## Instructions
Step by step instructions...

## Workflow
Detailed workflow...
```

## Rules
- Use clear, specific instructions
- Include example commands and code patterns
- Define when the skill should be used
- Keep skills focused on one task
