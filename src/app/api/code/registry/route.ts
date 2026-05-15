import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

/**
 * Claude Code Skill & Command Registry — reads DIRECTLY from code/ folder
 * 
 * Instead of importing one-by-one, this scans the actual code/ directory
 * to discover ALL available commands, skills, and tools.
 * 
 * Source: code/src/commands.ts (759 lines — THE master registry)
 *   - Loads from: code/src/commands/ (87 command dirs + 15 files)
 *   - Loads from: code/src/skills/bundled/ (17 skill files)
 *   - Loads from: code/src/tools/ (42+ tool dirs)
 *   - Loads from: code/src/tools.ts (getAllBaseTools)
 */

interface SkillEntry {
  name: string;
  type: 'command' | 'skill' | 'tool';
  source: string; // file path relative to code/src
  description?: string;
  prompt?: string;
}

// Read a .ts file and extract description/prompt text
function extractFromFile(filePath: string): { description: string; prompt: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Extract description from: description: 'xxx' or description: "xxx"
    const descMatch = content.match(/description[:\s]*['"`]([^'"`]+)['"`]/);
    const description = descMatch?.[1] || '';
    
    // Extract prompt content (look for template literals with instructions)
    const promptMatch = content.match(/(?:PROMPT|prompt|getPromptContent|MARKDOWN)\s*=\s*`([\s\S]*?)`/);
    const prompt = promptMatch?.[1]?.substring(0, 2000) || '';
    
    return { description, prompt };
  } catch {
    return { description: '', prompt: '' };
  }
}

export async function GET(req: NextRequest) {
  const codeBase = path.resolve(process.cwd(), 'code/src');
  
  if (!fs.existsSync(codeBase)) {
    return NextResponse.json({ error: 'code/ folder not found', registry: null });
  }

  const registry: {
    commands: SkillEntry[];
    skills: SkillEntry[];
    tools: SkillEntry[];
    stats: { commands: number; skills: number; tools: number; total: number };
  } = { commands: [], skills: [], tools: [], stats: { commands: 0, skills: 0, tools: 0, total: 0 } };

  // ─── 1. Scan commands/ directory ───
  const cmdDir = path.join(codeBase, 'commands');
  if (fs.existsSync(cmdDir)) {
    const entries = fs.readdirSync(cmdDir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name.replace(/\.(ts|tsx|js|jsx)$/, '');
      let filePath: string;
      
      if (entry.isDirectory()) {
        // Check for index.ts/index.js inside the directory
        const indexTs = path.join(cmdDir, entry.name, 'index.ts');
        const indexJs = path.join(cmdDir, entry.name, 'index.js');
        filePath = fs.existsSync(indexTs) ? indexTs : fs.existsSync(indexJs) ? indexJs : '';
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        filePath = path.join(cmdDir, entry.name);
      } else {
        continue;
      }
      
      if (!filePath) continue;
      
      const { description, prompt } = extractFromFile(filePath);
      registry.commands.push({
        name,
        type: 'command',
        source: `commands/${entry.name}`,
        description,
        prompt: prompt.substring(0, 500),
      });
    }
  }

  // ─── 2. Scan skills/bundled/ directory ───
  const skillsDir = path.join(codeBase, 'skills', 'bundled');
  if (fs.existsSync(skillsDir)) {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx'))) continue;
      if (entry.name === 'index.ts') continue;
      
      const name = entry.name.replace(/\.(ts|tsx)$/, '');
      const filePath = path.join(skillsDir, entry.name);
      const { description, prompt } = extractFromFile(filePath);
      
      registry.skills.push({
        name,
        type: 'skill',
        source: `skills/bundled/${entry.name}`,
        description,
        prompt: prompt.substring(0, 500),
      });
    }
  }

  // ─── 3. Scan tools/ directory ───
  const toolsDir = path.join(codeBase, 'tools');
  if (fs.existsSync(toolsDir)) {
    const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      // Look for the main tool file (ToolName.ts or ToolName.tsx)
      const toolFiles = fs.readdirSync(path.join(toolsDir, entry.name));
      const mainFile = toolFiles.find(f => 
        f.endsWith('.ts') && !f.includes('test') && !f.includes('spec') && 
        !f.includes('constants') && !f.includes('prompt') && !f.includes('utils')
      );
      
      if (!mainFile) continue;
      
      const filePath = path.join(toolsDir, entry.name, mainFile);
      const { description } = extractFromFile(filePath);
      
      // Also check for prompt.ts which contains the tool's system prompt
      const promptFile = path.join(toolsDir, entry.name, 'prompt.ts');
      let toolPrompt = '';
      if (fs.existsSync(promptFile)) {
        const { prompt } = extractFromFile(promptFile);
        toolPrompt = prompt;
      }
      
      registry.tools.push({
        name: entry.name,
        type: 'tool',
        source: `tools/${entry.name}`,
        description,
        prompt: toolPrompt.substring(0, 500),
      });
    }
  }

  registry.stats = {
    commands: registry.commands.length,
    skills: registry.skills.length,
    tools: registry.tools.length,
    total: registry.commands.length + registry.skills.length + registry.tools.length,
  };

  return NextResponse.json(registry);
}
