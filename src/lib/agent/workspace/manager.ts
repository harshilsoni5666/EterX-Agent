import fs from 'fs-extra';
import path from 'path';

function safeSegment(value: string, fallback: string): string {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return cleaned || fallback;
}

function resolveUnder(rootPath: string, ...segments: string[]): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`Blocked path traversal outside workspace: ${resolved}`);
  }
  return resolved;
}

async function writeFileAtomic(filePath: string, content: Buffer | string, encoding?: BufferEncoding): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.ensureDir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeFile(tmpPath, content, encoding as any);
  await fs.move(tmpPath, filePath, { overwrite: true });
}

/**
 * WorkspaceManager v2
 * 
 * Layer 3: Workspace isolation, sandbox support, and memory integration.
 * 
 * IMPROVEMENTS:
 * - Virtual Sandbox: Agent drafts intermediate files in sandbox/ before writing to user's real workspace
 * - Sandbox Promotion: When work is final, files are "promoted" from sandbox to real workspace
 * - Draft Workflow: Long documents are written page-by-page in sandbox, then compiled
 */
export class WorkspaceManager {
  private baseDir: string;
  private inputDir: string;
  private workingDir: string;
  private outputDir: string;
  private logsDir: string;
  private sandboxDir: string;

  constructor(userId: string, projectId: string) {
    const safeUserId = safeSegment(userId, 'user');
    const safeProjectId = safeSegment(projectId, 'project');
    this.baseDir = path.resolve(process.cwd(), '.workspaces', safeUserId, 'projects', safeProjectId);
    
    this.inputDir = path.join(this.baseDir, 'input');
    this.workingDir = path.join(this.baseDir, 'working');
    this.outputDir = path.join(this.baseDir, 'output');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.sandboxDir = path.join(this.baseDir, 'sandbox');
  }

  /**
   * Initialize local workspace directories + sandbox.
   */
  public async initialize(): Promise<void> {
    await fs.ensureDir(this.inputDir);
    await fs.ensureDir(this.workingDir);
    await fs.ensureDir(this.outputDir);
    await fs.ensureDir(this.logsDir);
    await fs.ensureDir(this.sandboxDir);
    
    await fs.writeFile(
      path.join(this.logsDir, 'system.log'),
      `[${new Date().toISOString()}] Workspace initialized.\n`,
      { flag: 'a' }
    );
  }

  /**
   * Retrieves an absolute path inside the working directory.
   */
  public getWorkingFilePath(filename: string): string {
    return resolveUnder(this.workingDir, filename);
  }

  /**
   * Get the sandbox directory path.
   */
  public getSandboxPath(filename?: string): string {
    if (filename) return resolveUnder(this.sandboxDir, filename);
    return this.sandboxDir;
  }

  /**
   * Write a draft file to the sandbox (not user's real workspace).
   */
  public async writeSandboxDraft(filename: string, content: string): Promise<string> {
    const filePath = resolveUnder(this.sandboxDir, filename);
    await writeFileAtomic(filePath, content, 'utf-8');
    console.log(`[WorkspaceManager] 📝 Sandbox draft written: ${filename}`);
    return filePath;
  }

  /**
   * Read a draft from the sandbox.
   */
  public async readSandboxDraft(filename: string): Promise<string> {
    const filePath = resolveUnder(this.sandboxDir, filename);
    if (!await fs.pathExists(filePath)) {
      throw new Error(`Sandbox draft not found: ${filename}`);
    }
    return fs.readFile(filePath, 'utf-8');
  }

  /**
   * List sandbox files.
   */
  public async listSandboxFiles(): Promise<string[]> {
    if (!await fs.pathExists(this.sandboxDir)) return [];
    return fs.readdir(this.sandboxDir);
  }

  /**
   * Promote a file from sandbox to the user's real output directory.
   * This is the "go live" step — only called when work is finalized.
   */
  public async promoteSandboxFile(filename: string, outputFilename?: string): Promise<string> {
    const sandboxPath = resolveUnder(this.sandboxDir, filename);
    if (!await fs.pathExists(sandboxPath)) {
      throw new Error(`Sandbox file not found: ${filename}`);
    }

    const destFilename = outputFilename || filename;
    const outputPath = resolveUnder(this.outputDir, destFilename);
    await fs.ensureDir(path.dirname(outputPath));
    await fs.copy(sandboxPath, outputPath);
    console.log(`[WorkspaceManager] 🚀 Promoted sandbox file: ${filename} → ${outputPath}`);
    return outputPath;
  }

  /**
   * Clean up the sandbox after a task is complete.
   */
  public async cleanSandbox(): Promise<void> {
    try {
      await fs.emptyDir(this.sandboxDir);
      console.log(`[WorkspaceManager] 🧹 Sandbox cleaned.`);
    } catch (e: any) {
      console.warn(`[WorkspaceManager] Could not clean sandbox: ${e.message}`);
    }
  }

  /**
   * Write intermediate work safely to the working directory.
   */
  public async writeDraft(filename: string, content: string): Promise<void> {
    const filePath = this.getWorkingFilePath(filename);
    await writeFileAtomic(filePath, content, 'utf-8');
  }

  /**
   * Export polished artifact to the output directory.
   */
  public async exportOutput(filename: string, content: Buffer | string): Promise<string> {
    const outputPath = resolveUnder(this.outputDir, filename);
    await writeFileAtomic(outputPath, content);
    return outputPath;
  }

  /**
   * Retrieves a list of files in the current workspace state.
   */
  public async listWorkingFiles(): Promise<string[]> {
    return fs.readdir(this.workingDir);
  }
}
