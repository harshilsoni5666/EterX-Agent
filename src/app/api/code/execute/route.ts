import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import * as path from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// POST: Execute a command in the workspace
export async function POST(req: NextRequest) {
  try {
    const { command, cwd } = await req.json();

    if (!command) {
      return NextResponse.json({ error: 'command is required' }, { status: 400 });
    }

    const workingDir = cwd || process.cwd();

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const child = exec(command, {
        cwd: workingDir,
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024, // 1MB max output
        env: { ...process.env, FORCE_COLOR: '0' }, // No ANSI colors for clean output
        shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode: error ? (error as any).code || 1 : 0,
        });
      });
    });

    return NextResponse.json({
      command,
      cwd: workingDir,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: result.exitCode === 0,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
