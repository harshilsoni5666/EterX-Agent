import fs from 'fs-extra';
import path from 'path';

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
    this.baseDir = path.resolve(process.cwd(), `.workspaces/${userId}/projects/${projectId}`);
    
    this.inputDir = path.join(this.baseDir, 'input');
    this.workingDir = path.join(this.baseDir, 'working');
    this.outputDir = path.join(this.baseDir, 'output');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.sandboxDir = path.resolve(process.cwd(), '.workspaces', 'sandbox');
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
    return path.join(this.workingDir, filename);
  }

  /**
   * Get the sandbox directory path.
   */
  public getSandboxPath(filename?: string): string {
    if (filename) return path.join(this.sandboxDir, filename);
    return this.sandboxDir;
  }

  /**
   * Write a draft file to the sandbox (not user's real workspace).
   */
  public async writeSandboxDraft(filename: string, content: string): Promise<string> {
    const filePath = path.join(this.sandboxDir, filename);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`[WorkspaceManager] 📝 Sandbox draft written: ${filename}`);
    return filePath;
  }

  /**
   * Read a draft from the sandbox.
   */
  public async readSandboxDraft(filename: string): Promise<string> {
    const filePath = path.join(this.sandboxDir, filename);
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
    const sandboxPath = path.join(this.sandboxDir, filename);
    if (!await fs.pathExists(sandboxPath)) {
      throw new Error(`Sandbox file not found: ${filename}`);
    }

    const destFilename = outputFilename || filename;
    const outputPath = path.join(this.outputDir, destFilename);
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
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Export polished artifact to the output directory.
   */
  public async exportOutput(filename: string, content: Buffer | string): Promise<string> {
    const outputPath = path.join(this.outputDir, filename);
    await fs.writeFile(outputPath, content);
    return outputPath;
  }

  /**
   * Retrieves a list of files in the current workspace state.
   */
  public async listWorkingFiles(): Promise<string[]> {
    return fs.readdir(this.workingDir);
  }
}
