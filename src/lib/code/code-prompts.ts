export function getCodeAgentSystemPrompt(cwd: string): string {
  return `You are a terminal-focused AI coding agent executing in the background.
Your task is directly applied inside the workspace at ${cwd}.
Use your tools to read files, search directories, create new code files, and build robust software.
Always verify code changes by reading the file after editing, and running syntax checks.`;
}

export function getToolEnhancements(): Record<string, string> {
  return {
    workspace_write_file: 'Ensure complete, run-ready files are written. Never write partial placeholders.',
    smart_refactor: 'Refactor surgically. Keep side effects to an absolute minimum.'
  };
}
