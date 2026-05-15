import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

/**
 * Browse filesystem folders for the Code view folder picker.
 * GET /api/code/browse?path=C:\Users  → lists subdirectories
 * GET /api/code/browse               → lists common starting points
 * POST /api/code/browse              → create a new folder
 */
export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const browsePath = searchParams.get('path');

  // If no path, return common starting points
  if (!browsePath) {
    const home = os.homedir();
    const desktop = path.join(home, 'Desktop');
    const docs = path.join(home, 'Documents');
    const projects = path.join(home, 'Projects');
    
    const roots: Array<{ name: string; path: string; exists: boolean }> = [
      { name: 'Desktop', path: desktop, exists: fs.existsSync(desktop) },
      { name: 'Documents', path: docs, exists: fs.existsSync(docs) },
      { name: 'Projects', path: projects, exists: fs.existsSync(projects) },
      { name: 'Home', path: home, exists: true },
    ];

    // Add common dev folders
    const devFolders = [
      'c:\\Harshil projects',
      'C:\\Projects',
      'C:\\dev',
      path.join(home, 'dev'),
      path.join(home, 'code'),
      path.join(home, 'workspace'),
    ];

    for (const dp of devFolders) {
      if (fs.existsSync(dp) && !roots.some(r => r.path === dp)) {
        roots.push({ name: path.basename(dp), path: dp, exists: true });
      }
    }

    return NextResponse.json({ roots: roots.filter(r => r.exists) });
  }

  // List subdirectories of the given path
  try {
    const resolved = path.resolve(browsePath);
    if (!fs.existsSync(resolved)) {
      return NextResponse.json({ error: 'Path does not exist', folders: [] }, { status: 404 });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'Not a directory', folders: [] }, { status: 400 });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const folders = entries
      .filter(e => {
        if (!e.isDirectory()) return false;
        // Skip hidden/system folders
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') return false;
        if (e.name === '$Recycle.Bin' || e.name === 'System Volume Information') return false;
        return true;
      })
      .map(e => {
        const fullPath = path.join(resolved, e.name);
        let isProject = false;
        try {
          // Check if it's a project folder (has package.json, Cargo.toml, etc.)
          const files = fs.readdirSync(fullPath);
          isProject = files.some(f => 
            ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
             'pom.xml', 'build.gradle', 'Gemfile', 'tsconfig.json', '.csproj',
             'Dockerfile', 'docker-compose.yml', '.git'].includes(f)
          );
        } catch { }
        return { name: e.name, path: fullPath, isProject };
      })
      .sort((a, b) => {
        // Projects first, then alphabetical
        if (a.isProject && !b.isProject) return -1;
        if (!a.isProject && b.isProject) return 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 100); // Cap at 100

    const parentPath = path.dirname(resolved);

    return NextResponse.json({
      current: resolved,
      parent: parentPath !== resolved ? parentPath : null,
      folders,
      isProject: folders.length === 0 || entries.some(e => 
        ['package.json', 'Cargo.toml', 'go.mod', '.git', 'tsconfig.json'].includes(e.name)
      ),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, folders: [] }, { status: 500 });
  }
}

/**
 * Create a new project folder
 */
export async function POST(req: NextRequest) {
  const { parentPath, folderName } = await req.json();

  if (!parentPath || !folderName) {
    return NextResponse.json({ error: 'parentPath and folderName are required' }, { status: 400 });
  }

  const newPath = path.join(parentPath, folderName);

  try {
    if (fs.existsSync(newPath)) {
      return NextResponse.json({ error: 'Folder already exists', path: newPath }, { status: 409 });
    }

    fs.mkdirSync(newPath, { recursive: true });
    return NextResponse.json({ success: true, path: newPath });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
