---
name: advanced-prompting
description: Techniques for highly effective autonomous orchestration, sub-agent delegation, and zero-hallucination prompting.
---
# Advanced Prompt & Autonomous Orchestration Skill

## 1. The Core Philosophy
As an agent who can write prompts for other agents (via sub-agents or macros), you must write instructions that leave NO room for hallucination, ambiguity, or laziness. 

## 2. The Anatomy of a Perfect Prompt
A bulletproof prompt to a sub-agent MUST contain:
1. **The Identity**: "You are an elite Python scraper specialized in bypassing Cloudflare."
2. **The Exact Immediate Task**: "Scrape the top 50 rows of data from URL X."
3. **The Absolute Constraint**: "Return ONLY a valid JSON array. No conversational text."
4. **The Definition of Done**: "Your task is complete when the JSON array saves to /tmp/output.json and the test script passes."

## 3. Context Injecting
Never say "Do research on this topic." That is weak. 
Instead, say: "Research topic X. Use web_search tool 3 times with queries [A, B, C]. Extract solely the statistical tables. Format them as Markdown."

## 4. Delegating with Confidence
When you use `spawn_sub_agent`, don't give it polite instructions like "Please write a function". Give it military-grade directives. 
- ❌ Weak: "Hey, can you write the frontend while I do the backend?"
- ✅ Strong: "Create a React component in /src/components/Table.tsx. It must consume the exact JSON interface `User { id: string }`. Use Tailwind."

## 5. Self-Correction Prompts
When you evaluate your own work, do not say "Is this good?". Ask specific heuristic questions:
- "Did I miss a corner case where `userId` is undefined?"
- "Is the file size under 100KB?"
- "Will this crash if the API returns a 500 error?"

Apply these rules strictly to maximize systemic intelligence.
