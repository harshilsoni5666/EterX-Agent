import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Environment Manager — Smart .env & Config Management
 * 
 * Manages environment variables, API keys, and configuration files
 * across different environments (dev, staging, production).
 * 
 * FEATURES:
 * - Read/write .env files safely
 * - Compare env files across environments
 * - Validate env vars (check required keys exist)
 * - Auto-generate .env.example from .env (stripping values)
 * - Check for missing env vars vs code usage
 * - Manage API key vault (.workspaces/vault/)
 */
export const envManagerTool: ToolDefinition = {
  name: 'env_manager',
  description: `Manage environment variables and configuration files.

MODES:
- "read": Read all vars from a .env file
- "set": Set a variable in a .env file (creates if not exists)
- "delete": Remove a variable from a .env file
- "compare": Compare two .env files, show differences
- "validate": Check if required env vars are set
- "generate_example": Create .env.example from .env (strips values)
- "scan_usage": Scan code for process.env references, find missing vars

EXAMPLES:
- Read: { mode: "read", file: ".env" }
- Set: { mode: "set", file: ".env", key: "API_KEY", value: "sk-..." }
- Compare: { mode: "compare", file: ".env", secondFile: ".env.production" }
- Validate: { mode: "validate", file: ".env", requiredKeys: ["DATABASE_URL", "JWT_SECRET"] }`,
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['read', 'set', 'delete', 'compare', 'validate', 'generate_example', 'scan_usage'])
      .describe('Operation mode'),
    file: z.string().optional().default('.env').describe('.env file path'),
    secondFile: z.string().optional().describe('Second .env file (for compare)'),
    key: z.string().optional().describe('Variable name (for set/delete)'),
    value: z.string().optional().describe('Variable value (for set)'),
    requiredKeys: z.array(z.string()).optional().describe('Required keys to validate'),
    scanDir: z.string().optional().describe('Directory to scan for env usage (for scan_usage)')
  }),
  outputSchema: z.object({ success: z.boolean(), result: z.any(), message: z.string() }),
  execute: async (input: any) => {
    const envFile = path.isAbsolute(input.file || '.env')
      ? input.file
      : path.resolve(process.cwd(), input.file || '.env');

    switch (input.mode) {
      case 'read': {
        if (!await fs.pathExists(envFile)) {
          return { success: false, result: {}, message: `File not found: ${envFile}` };
        }
        const content = await fs.readFile(envFile, 'utf-8');
        const vars: Record<string, string> = {};
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
              const key = trimmed.substring(0, eqIdx).trim();
              const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
              vars[key] = val.length > 20 ? val.substring(0, 8) + '***' + val.slice(-4) : val;
            }
          }
        }
        return { success: true, result: vars, message: `${Object.keys(vars).length} variables found in ${path.basename(envFile)}` };
      }

      case 'set': {
        if (!input.key) return { success: false, result: null, message: 'key is required' };
        let content = '';
        if (await fs.pathExists(envFile)) {
          content = await fs.readFile(envFile, 'utf-8');
        }
        const regex = new RegExp(`^${input.key}=.*$`, 'm');
        const newLine = `${input.key}=${input.value || ''}`;
        if (regex.test(content)) {
          content = content.replace(regex, newLine);
        } else {
          content = content.trimEnd() + '\n' + newLine + '\n';
        }
        await fs.writeFile(envFile, content, 'utf-8');
        return { success: true, result: { key: input.key }, message: `Set ${input.key} in ${path.basename(envFile)}` };
      }

      case 'delete': {
        if (!input.key) return { success: false, result: null, message: 'key is required' };
        if (!await fs.pathExists(envFile)) {
          return { success: false, result: null, message: 'File not found' };
        }
        let content = await fs.readFile(envFile, 'utf-8');
        const lines = content.split('\n').filter(l => !l.trim().startsWith(input.key + '='));
        await fs.writeFile(envFile, lines.join('\n'), 'utf-8');
        return { success: true, result: { key: input.key }, message: `Removed ${input.key}` };
      }

      case 'compare': {
        if (!input.secondFile) return { success: false, result: null, message: 'secondFile is required' };
        const file2 = path.isAbsolute(input.secondFile) ? input.secondFile : path.resolve(process.cwd(), input.secondFile);

        const parse = async (f: string) => {
          if (!await fs.pathExists(f)) return {};
          const content = await fs.readFile(f, 'utf-8');
          const vars: Record<string, string> = {};
          for (const line of content.split('\n')) {
            const t = line.trim();
            if (t && !t.startsWith('#')) {
              const eq = t.indexOf('=');
              if (eq > 0) vars[t.substring(0, eq).trim()] = t.substring(eq + 1).trim();
            }
          }
          return vars;
        };

        const vars1 = await parse(envFile);
        const vars2 = await parse(file2);
        const allKeys = new Set([...Object.keys(vars1), ...Object.keys(vars2)]);
        const diff: any = { onlyIn1: [], onlyIn2: [], different: [], same: [] };

        for (const key of allKeys) {
          if (key in vars1 && !(key in vars2)) diff.onlyIn1.push(key);
          else if (!(key in vars1) && key in vars2) diff.onlyIn2.push(key);
          else if (vars1[key] !== vars2[key]) diff.different.push(key);
          else diff.same.push(key);
        }

        return {
          success: true, result: diff,
          message: `Comparison: ${diff.same.length} same, ${diff.different.length} different, ${diff.onlyIn1.length} only in file1, ${diff.onlyIn2.length} only in file2`
        };
      }

      case 'validate': {
        if (!input.requiredKeys?.length) return { success: false, result: null, message: 'requiredKeys array is required' };
        if (!await fs.pathExists(envFile)) {
          return { success: false, result: { missing: input.requiredKeys }, message: 'Env file not found — all keys missing' };
        }
        const content = await fs.readFile(envFile, 'utf-8');
        const keys = new Set<string>();
        for (const line of content.split('\n')) {
          const eq = line.trim().indexOf('=');
          if (eq > 0 && !line.trim().startsWith('#')) keys.add(line.trim().substring(0, eq).trim());
        }
        const missing = input.requiredKeys.filter((k: string) => !keys.has(k));
        const present = input.requiredKeys.filter((k: string) => keys.has(k));
        return {
          success: missing.length === 0,
          result: { present, missing },
          message: missing.length === 0
            ? `✅ All ${input.requiredKeys.length} required vars present`
            : `⚠️ ${missing.length} missing: ${missing.join(', ')}`
        };
      }

      case 'generate_example': {
        if (!await fs.pathExists(envFile)) {
          return { success: false, result: null, message: 'Source env file not found' };
        }
        const content = await fs.readFile(envFile, 'utf-8');
        const example = content.split('\n').map(line => {
          const t = line.trim();
          if (!t || t.startsWith('#')) return line;
          const eq = t.indexOf('=');
          if (eq > 0) return t.substring(0, eq + 1);
          return line;
        }).join('\n');
        const examplePath = envFile.replace(/\.env.*$/, '.env.example');
        await fs.writeFile(examplePath, example, 'utf-8');
        return { success: true, result: { path: examplePath }, message: `Generated ${path.basename(examplePath)}` };
      }

      case 'scan_usage': {
        const scanDir = input.scanDir
          ? (path.isAbsolute(input.scanDir) ? input.scanDir : path.resolve(process.cwd(), input.scanDir))
          : path.resolve(process.cwd(), 'src');
        
        const usedVars = new Set<string>();
        async function scan(dir: string, depth: number) {
          if (depth > 4) return;
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) await scan(full, depth + 1);
              else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
                const content = await fs.readFile(full, 'utf-8');
                const matches = content.matchAll(/process\.env\.(\w+)/g);
                for (const m of matches) usedVars.add(m[1]);
                const matches2 = content.matchAll(/process\.env\[['"](\w+)['"]\]/g);
                for (const m of matches2) usedVars.add(m[1]);
              }
            }
          } catch { }
        }
        await scan(scanDir, 0);

        // Check which are defined
        let definedVars = new Set<string>();
        if (await fs.pathExists(envFile)) {
          const content = await fs.readFile(envFile, 'utf-8');
          for (const line of content.split('\n')) {
            const eq = line.trim().indexOf('=');
            if (eq > 0 && !line.trim().startsWith('#')) definedVars.add(line.trim().substring(0, eq).trim());
          }
        }

        const missing = Array.from(usedVars).filter(v => !definedVars.has(v));
        const unused = Array.from(definedVars).filter(v => !usedVars.has(v));

        return {
          success: true,
          result: { usedInCode: Array.from(usedVars), definedInEnv: Array.from(definedVars), missing, unused },
          message: `Found ${usedVars.size} env vars in code, ${definedVars.size} in .env. Missing: ${missing.length}. Unused: ${unused.length}.`
        };
      }

      default:
        return { success: false, result: null, message: `Unknown mode: ${input.mode}` };
    }
  }
};

/**
 * Auto-Documentation Generator — Generate Docs from Code
 * 
 * Analyzes code and generates documentation automatically:
 * - README.md from project structure
 * - API docs from Express routes
 * - Component docs from React components
 * - Function signatures and JSDocs
 */
export const autoDocsTool: ToolDefinition = {
  name: 'auto_docs',
  description: `Automatically generate documentation from code.

MODES:
- "readme": Generate a README.md from project analysis (package.json, structure, deps)
- "api": Generate API documentation from Express route files
- "components": Generate component documentation from React/TSX files
- "functions": Generate function documentation from a file (signatures + descriptions)

EXAMPLES:
- README: { mode: "readme", target: "." }
- API docs: { mode: "api", target: "src/routes" }
- Component docs: { mode: "components", target: "src/components" }
- Function docs: { mode: "functions", target: "src/lib/utils.ts" }`,
  category: 'workspace',
  inputSchema: z.object({
    mode: z.enum(['readme', 'api', 'components', 'functions']).describe('Documentation mode'),
    target: z.string().describe('Target file or directory'),
    outputFile: z.string().optional().describe('Where to save docs (default: auto-generated)')
  }),
  outputSchema: z.object({ success: z.boolean(), docs: z.string(), savedTo: z.string() }),
  execute: async (input: { mode: string, target: string, outputFile?: string }) => {
    const targetPath = path.isAbsolute(input.target) ? input.target : path.resolve(process.cwd(), input.target);

    switch (input.mode) {
      case 'readme': {
        let readme = '';
        const pkgPath = path.join(targetPath, 'package.json');

        if (await fs.pathExists(pkgPath)) {
          const pkg = await fs.readJson(pkgPath);
          readme += `# ${pkg.name || path.basename(targetPath)}\n\n`;
          readme += `${pkg.description || 'A project.'}\n\n`;
          readme += `## Installation\n\n\`\`\`bash\nnpm install\n\`\`\`\n\n`;

          if (pkg.scripts) {
            readme += `## Scripts\n\n`;
            readme += `| Command | Description |\n|---------|-------------|\n`;
            for (const [name, cmd] of Object.entries(pkg.scripts)) {
              readme += `| \`npm run ${name}\` | \`${cmd}\` |\n`;
            }
            readme += '\n';
          }

          if (pkg.dependencies) {
            readme += `## Dependencies\n\n`;
            for (const [name, ver] of Object.entries(pkg.dependencies)) {
              readme += `- \`${name}\`: ${ver}\n`;
            }
            readme += '\n';
          }
        } else {
          readme += `# ${path.basename(targetPath)}\n\n`;
        }

        // Scan directory structure
        readme += `## Project Structure\n\n\`\`\`\n`;
        async function tree(dir: string, prefix: string, depth: number) {
          if (depth > 3) return;
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const filtered = entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules');
            for (let i = 0; i < filtered.length; i++) {
              const e = filtered[i];
              const connector = i === filtered.length - 1 ? '└── ' : '├── ';
              readme += `${prefix}${connector}${e.name}${e.isDirectory() ? '/' : ''}\n`;
              if (e.isDirectory()) {
                const np = prefix + (i === filtered.length - 1 ? '    ' : '│   ');
                await tree(path.join(dir, e.name), np, depth + 1);
              }
            }
          } catch { }
        }
        await tree(targetPath, '', 0);
        readme += `\`\`\`\n\n`;

        readme += `## License\n\nMIT\n`;

        const outputPath = input.outputFile || path.join(targetPath, 'README.md');
        await fs.writeFile(outputPath, readme, 'utf-8');
        return { success: true, docs: readme.substring(0, 3000), savedTo: outputPath };
      }

      case 'api': {
        let docs = `# API Documentation\n\n`;
        docs += `Generated: ${new Date().toLocaleDateString()}\n\n`;

        async function scanRoutes(dir: string) {
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                await scanRoutes(path.join(dir, entry.name));
              } else if (/\.(ts|js)$/.test(entry.name)) {
                const content = await fs.readFile(path.join(dir, entry.name), 'utf-8');
                const routeRegex = /router\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
                let match;
                const routes: string[] = [];
                while ((match = routeRegex.exec(content)) !== null) {
                  routes.push(`${match[1].toUpperCase()} ${match[2]}`);
                }
                if (routes.length > 0) {
                  docs += `### ${entry.name}\n\n`;
                  for (const route of routes) {
                    const [method, p] = route.split(' ');
                    docs += `- **\`${method}\`** \`${p}\`\n`;
                  }
                  docs += '\n';
                }
              }
            }
          } catch { }
        }
        await scanRoutes(targetPath);

        const outputPath = input.outputFile || path.join(process.cwd(), '.workspaces', 'sandbox', 'api_docs.md');
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, docs, 'utf-8');
        return { success: true, docs: docs.substring(0, 3000), savedTo: outputPath };
      }

      case 'functions': {
        if (!await fs.pathExists(targetPath)) {
          return { success: false, docs: '', savedTo: '' };
        }
        const content = await fs.readFile(targetPath, 'utf-8');
        let docs = `# Function Documentation: ${path.basename(targetPath)}\n\n`;

        const funcRegex = /(?:\/\*\*[\s\S]*?\*\/\s*)?(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]*)\s*=>)/gm;
        let match;
        while ((match = funcRegex.exec(content)) !== null) {
          const name = match[1] || match[2];
          if (name) {
            // Look for JSDoc above
            const before = content.substring(Math.max(0, match.index - 500), match.index);
            const jsdocMatch = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
            docs += `### \`${name}\`\n\n`;
            if (jsdocMatch) {
              const cleaned = jsdocMatch[1].replace(/\s*\*\s*/g, '\n').trim();
              docs += `${cleaned}\n\n`;
            }
            // Extract params
            const paramMatch = content.substring(match.index, match.index + 300).match(/\(([^)]*)\)/);
            if (paramMatch && paramMatch[1].trim()) {
              docs += `**Parameters:** \`${paramMatch[1].trim().substring(0, 100)}\`\n\n`;
            }
          }
        }

        const outputPath = input.outputFile || path.join(process.cwd(), '.workspaces', 'sandbox', `docs_${path.basename(targetPath, path.extname(targetPath))}.md`);
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, docs, 'utf-8');
        return { success: true, docs: docs.substring(0, 3000), savedTo: outputPath };
      }

      case 'components': {
        let docs = `# Component Documentation\n\n`;

        async function scanComponents(dir: string) {
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                await scanComponents(path.join(dir, entry.name));
              } else if (/\.(tsx|jsx)$/.test(entry.name)) {
                const content = await fs.readFile(path.join(dir, entry.name), 'utf-8');
                // Find component exports
                const compRegex = /export\s+(?:default\s+)?(?:function|const)\s+(\w+)/g;
                let match;
                while ((match = compRegex.exec(content)) !== null) {
                  const name = match[1];
                  docs += `### \`<${name} />\`\n\n`;
                  docs += `**File:** \`${path.relative(process.cwd(), path.join(dir, entry.name))}\`\n\n`;

                  // Find props interface
                  const propsMatch = content.match(new RegExp(`interface\\s+${name}Props\\s*\\{([^}]+)\\}`));
                  if (propsMatch) {
                    docs += `**Props:**\n\`\`\`typescript\n${propsMatch[0]}\n\`\`\`\n\n`;
                  }
                }
              }
            }
          } catch { }
        }
        await scanComponents(targetPath);

        const outputPath = input.outputFile || path.join(process.cwd(), '.workspaces', 'sandbox', 'component_docs.md');
        await fs.ensureDir(path.dirname(outputPath));
        await fs.writeFile(outputPath, docs, 'utf-8');
        return { success: true, docs: docs.substring(0, 3000), savedTo: outputPath };
      }

      default:
        return { success: false, docs: '', savedTo: '' };
    }
  }
};
