import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
  children?: FileEntry[];
}

// Directories/files to always skip
const SKIP_NAMES = new Set([
  'node_modules', '.git', '.next', 'dist', '.cache',
  '__pycache__', '.DS_Store', 'Thumbs.db', '.env.local',
  '.env', 'package-lock.json', 'bun.lock', 'tsconfig.tsbuildinfo'
]);

function getFileTree(dirPath: string, depth: number = 0, maxDepth: number = 3): FileEntry[] {
  if (depth > maxDepth) return [];
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result: FileEntry[] = [];

    // Sort: directories first, then files, alphabetically
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      if (SKIP_NAMES.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.vscode') continue;

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children: getFileTree(fullPath, depth + 1, maxDepth),
        });
      } else {
        try {
          const stats = fs.statSync(fullPath);
          result.push({
            name: entry.name,
            path: fullPath,
            type: 'file',
            size: stats.size,
            extension: path.extname(entry.name).slice(1).toLowerCase(),
          });
        } catch {
          result.push({
            name: entry.name,
            path: fullPath,
            type: 'file',
            extension: path.extname(entry.name).slice(1).toLowerCase(),
          });
        }
      }
    }

    return result;
  } catch (error) {
    return [];
  }
}

// GET: List directory contents or get file tree
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const dirPath = searchParams.get('path') || process.cwd();
    const maxDepth = parseInt(searchParams.get('depth') || '3', 10);

    if (!fs.existsSync(dirPath)) {
      return NextResponse.json({ error: 'Path does not exist' }, { status: 404 });
    }

    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    const tree = getFileTree(dirPath, 0, maxDepth);
    return NextResponse.json({ 
      root: dirPath,
      tree,
      name: path.basename(dirPath)
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST: Read file content
export async function POST(req: NextRequest) {
  try {
    const { filePath, offset, limit } = await req.json();

    if (!filePath) {
      return NextResponse.json({ error: 'filePath is required' }, { status: 400 });
    }

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'File does not exist' }, { status: 404 });
    }

    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is a directory, not a file' }, { status: 400 });
    }

    // Safety: max 2MB files
    if (stats.size > 2 * 1024 * 1024) {
      return NextResponse.json({ 
        error: 'File too large',
        size: stats.size,
        maxSize: 2 * 1024 * 1024
      }, { status: 413 });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    // Apply offset and limit if provided
    const startLine = Math.max(0, (offset || 1) - 1);
    const endLine = limit ? Math.min(startLine + limit, totalLines) : totalLines;
    const slicedContent = lines.slice(startLine, endLine).join('\n');

    return NextResponse.json({
      filePath,
      content: slicedContent,
      totalLines,
      startLine: startLine + 1,
      endLine,
      language: getLanguageFromExt(path.extname(filePath).slice(1).toLowerCase()),
      size: stats.size,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function getLanguageFromExt(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', cs: 'csharp',
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html',
    css: 'css', scss: 'scss', less: 'less', sql: 'sql', sh: 'bash',
    bash: 'bash', zsh: 'bash', md: 'markdown', mdx: 'markdown',
    toml: 'toml', ini: 'ini', cfg: 'ini', env: 'bash',
    dockerfile: 'dockerfile', makefile: 'makefile',
  };
  return map[ext] || 'text';
}
