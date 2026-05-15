import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs/promises';
import fse from 'fs-extra';
import { resolveWorkspacePath } from '../../workspace/path_resolver';

/**
 * Code Generator — Template-Based Code Scaffolding
 * 
 * Generates complete project structures, boilerplate code,
 * and component templates for common frameworks/patterns.
 */
export const codeGeneratorTool: ToolDefinition = {
  name: 'code_generator',
  description: `Generate complete code scaffolds, project structures, and boilerplate for common patterns. Creates multiple files at once with proper structure.
  
  Supported templates:
  - react_component: React component with styles
  - express_api: Express.js API endpoint
  - html_page: Complete HTML page with CSS/JS
  - python_script: Python script with proper structure
  - node_project: Node.js project with package.json
  - docker: Dockerfile + docker-compose
  - github_actions: CI/CD pipeline
  - rest_api: Full REST API scaffold
  - nextjs_page: Next.js page component`,
  category: 'workspace',
  inputSchema: z.object({
    template: z.enum([
      'react_component', 'express_api', 'html_page', 'python_script',
      'node_project', 'docker', 'github_actions', 'rest_api', 'nextjs_page',
      'typescript_module', 'readme', 'env_file', 'gitignore'
    ]).describe('Template type to generate'),
    name: z.string().describe('Name for the generated component/project'),
    options: z.string().optional().describe('Additional options as JSON (e.g., {"port": 3000, "database": "postgres"})')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    files: z.array(z.string()),
    message: z.string()
  }),
  execute: async (input: { template: string, name: string, options?: string }) => {
    const opts = input.options ? JSON.parse(input.options) : {};
    const generatedFiles: string[] = [];

    console.log(`[Tool: code_generator] Template: ${input.template}, Name: ${input.name}`);

    try {
      const writeFile = async (relativePath: string, content: string) => {
        const fullPath = resolveWorkspacePath(relativePath);
        await fse.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, content, 'utf-8');
        generatedFiles.push(fullPath);
      };

      switch (input.template) {
        case 'react_component': {
          await writeFile(`${input.name}/${input.name}.tsx`, `import React, { useState, useEffect } from 'react';
import './${input.name}.css';

interface ${input.name}Props {
  title?: string;
  className?: string;
}

export const ${input.name}: React.FC<${input.name}Props> = ({ title = '${input.name}', className = '' }) => {
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(false);
  }, []);

  if (isLoading) return <div className="${input.name.toLowerCase()}-loading">Loading...</div>;

  return (
    <div className={\`${input.name.toLowerCase()} \${className}\`}>
      <h2>{title}</h2>
      {/* Add your component content here */}
    </div>
  );
};

export default ${input.name};
`);
          await writeFile(`${input.name}/${input.name}.css`, `.${input.name.toLowerCase()} {
  padding: 1rem;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.${input.name.toLowerCase()} h2 {
  margin: 0 0 1rem 0;
  font-size: 1.25rem;
  color: #1a1a2e;
}

.${input.name.toLowerCase()}-loading {
  padding: 2rem;
  text-align: center;
  color: #888;
}
`);
          await writeFile(`${input.name}/index.ts`, `export { default as ${input.name} } from './${input.name}';\n`);
          break;
        }

        case 'express_api': {
          const port = opts.port || 3000;
          await writeFile(`${input.name}/server.ts`, `import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || ${port};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// Routes
app.get('/api/${input.name.toLowerCase()}', async (req, res) => {
  try {
    // TODO: Implement your logic here
    res.json({ data: [], message: '${input.name} endpoint ready' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/${input.name.toLowerCase()}', async (req, res) => {
  try {
    const data = req.body;
    // TODO: Process and save data
    res.status(201).json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(\`🚀 ${input.name} API running on http://localhost:\${PORT}\`);
});

export default app;
`);
          await writeFile(`${input.name}/package.json`, JSON.stringify({
            name: input.name.toLowerCase(),
            version: '1.0.0',
            scripts: { dev: 'tsx server.ts', build: 'tsc', start: 'node dist/server.js' },
            dependencies: { express: '^4.18.0', cors: '^2.8.5' },
            devDependencies: { '@types/express': '^4.17.0', '@types/cors': '^2.8.0', tsx: '^4.0.0', typescript: '^5.0.0' }
          }, null, 2));
          break;
        }

        case 'html_page': {
          await writeFile(`${input.name}.html`, `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${input.name} - Generated by EterX Agent">
  <title>${input.name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 800px;
      padding: 3rem;
      background: rgba(255,255,255,0.05);
      backdrop-filter: blur(20px);
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 { font-size: 2.5rem; margin-bottom: 1rem; background: linear-gradient(90deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    p { line-height: 1.8; color: #b0b0b0; }
    .btn { display: inline-block; margin-top: 1.5rem; padding: 12px 32px; background: linear-gradient(90deg, #667eea, #764ba2); color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; transition: transform 0.2s; }
    .btn:hover { transform: translateY(-2px); }
  </style>
</head>
<body>
  <div class="container">
    <h1>${input.name}</h1>
    <p>Your next-generation page is ready. Built autonomously by EterX Agent.</p>
    <button class="btn" onclick="alert('Hello from ${input.name}!')">Get Started</button>
  </div>
  <script>
    console.log('${input.name} loaded successfully');
  </script>
</body>
</html>
`);
          break;
        }

        case 'node_project': {
          await writeFile(`${input.name}/package.json`, JSON.stringify({
            name: input.name.toLowerCase(),
            version: '1.0.0',
            description: `${input.name} - Generated by EterX Agent`,
            main: 'dist/index.js',
            scripts: { dev: 'tsx src/index.ts', build: 'tsc', start: 'node dist/index.js', test: 'jest' },
            dependencies: {},
            devDependencies: { typescript: '^5.0.0', tsx: '^4.0.0', '@types/node': '^20.0.0' }
          }, null, 2));
          await writeFile(`${input.name}/tsconfig.json`, JSON.stringify({
            compilerOptions: { target: 'ES2022', module: 'commonjs', outDir: './dist', rootDir: './src', strict: true, esModuleInterop: true, skipLibCheck: true },
            include: ['src/**/*']
          }, null, 2));
          await writeFile(`${input.name}/src/index.ts`, `console.log('🚀 ${input.name} is running!');\n\n// Start building here\n`);
          await writeFile(`${input.name}/.gitignore`, `node_modules/\ndist/\n.env\n`);
          break;
        }

        case 'docker': {
          await writeFile(`${input.name}/Dockerfile`, `FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE ${opts.port || 3000}
CMD ["node", "dist/index.js"]
`);
          await writeFile(`${input.name}/docker-compose.yml`, `version: '3.8'
services:
  ${input.name.toLowerCase()}:
    build: .
    ports:
      - "${opts.port || 3000}:${opts.port || 3000}"
    environment:
      - NODE_ENV=production
    restart: unless-stopped
    volumes:
      - ./data:/app/data
`);
          await writeFile(`${input.name}/.dockerignore`, `node_modules\ndist\n.git\n*.md\n`);
          break;
        }

        case 'github_actions': {
          await writeFile(`${input.name}/.github/workflows/ci.yml`, `name: CI/CD Pipeline
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]
    steps:
      - uses: actions/checkout@v4
      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - run: npm test
      
  deploy:
    needs: build-and-test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        run: echo "Add your deployment steps here"
`);
          break;
        }

        case 'typescript_module': {
          await writeFile(`${input.name}.ts`, `/**
 * ${input.name} Module
 * Generated by EterX Agent
 */

export interface ${input.name}Config {
  // Add configuration options here
  debug?: boolean;
}

export class ${input.name} {
  private config: ${input.name}Config;

  constructor(config: ${input.name}Config = {}) {
    this.config = config;
  }

  /**
   * Initialize the module
   */
  public async initialize(): Promise<void> {
    if (this.config.debug) console.log('[${input.name}] Initializing...');
    // Add initialization logic
  }

  /**
   * Main execution method
   */
  public async execute(input: any): Promise<any> {
    if (this.config.debug) console.log('[${input.name}] Executing with input:', input);
    // Add execution logic
    return { success: true };
  }
}

export default ${input.name};
`);
          break;
        }

        case 'readme': {
          await writeFile(`README.md`, `# ${input.name}

> Generated by EterX Agent

## Overview
${opts.description || 'A project generated autonomously by the EterX AI Agent.'}

## Getting Started

\`\`\`bash
npm install
npm run dev
\`\`\`

## Features
- Feature 1
- Feature 2
- Feature 3

## License
MIT
`);
          break;
        }

        case 'env_file': {
          await writeFile(`.env.example`, `# ${input.name} Environment Variables
# Generated by EterX Agent

NODE_ENV=development
PORT=${opts.port || 3000}
DATABASE_URL=
API_KEY=
SECRET_KEY=
`);
          break;
        }

        case 'gitignore': {
          await writeFile(`.gitignore`, `# Dependencies
node_modules/
.pnp
.pnp.js

# Build
dist/
build/
.next/
out/

# Environment
.env
.env.local
.env.*.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*

# Test
coverage/
`);
          break;
        }

        default: {
          await writeFile(`${input.name}/README.md`, `# ${input.name}\n\nGenerated scaffold.\n`);
        }
      }

      return {
        success: true,
        files: generatedFiles,
        message: `✅ Generated ${generatedFiles.length} files for "${input.name}" (template: ${input.template}):\n${generatedFiles.map(f => `  📄 ${f}`).join('\n')}`
      };

    } catch (error: any) {
      return { success: false, files: generatedFiles, message: `Code generation failed: ${error.message}` };
    }
  }
};
