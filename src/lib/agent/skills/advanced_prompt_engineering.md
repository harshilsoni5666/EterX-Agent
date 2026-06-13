---
name: advanced-prompting
description: Techniques for clear task orchestration, safe delegation through available tools, and low-hallucination prompting.
---
# Advanced Prompt & Autonomous Orchestration Skill

## 1. The Core Philosophy
When writing prompts, task briefs, or handoff instructions, make them specific enough that another model, script, or human can execute them without guessing. 

## 2. The Anatomy of a Perfect Prompt
A strong task brief MUST contain:
1. **The Identity**: "You are a Python data extraction specialist who respects robots.txt, site terms, rate limits, and authorization boundaries."
2. **The Exact Immediate Task**: "Extract the top 50 rows from authorized source X while respecting access limits."
3. **The Absolute Constraint**: "Return ONLY a valid JSON array. No conversational text."
4. **The Definition of Done**: "Your task is complete when the JSON array saves to /tmp/output.json and the test script passes."

## 3. Context Injecting
Never say "Do research on this topic." That is weak. 
Instead, say: "Research topic X. Use web_search tool 3 times with queries [A, B, C]. Extract solely the statistical tables. Format them as Markdown."

## 4. Delegating with Confidence
Only delegate through tools that actually exist in the current runtime. If no delegation tool exists, use the same structure for your own implementation checklist. 
- [bad] Weak: "Hey, can you write the frontend while I do the backend?"
- [good] Strong: "Create a React component in /src/components/Table.tsx. It must consume the exact JSON interface `User { id: string }`. Use Tailwind."

## 5. Self-Correction Prompts
When you evaluate your own work, do not say "Is this good?". Ask specific heuristic questions:
- "Did I miss a corner case where `userId` is undefined?"
- "Is the file size under 100KB?"
- "Will this crash if the API returns a 500 error?"

Apply these rules strictly to maximize systemic intelligence.
