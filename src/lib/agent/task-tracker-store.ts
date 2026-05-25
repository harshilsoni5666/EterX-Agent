import fs from 'fs-extra';
import path from 'path';

const TASKS_DIR = path.resolve(process.cwd(), '.workspaces', '.tasks');

export type TaskTrackerStep = {
  id: string;
  step: number;
  name: string;
  description: string;
  tools: string[];
  done_when: string;
  depends_on: number[];
  priority: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  completedAt: number | null;
};

export type TaskTrackerData = {
  goal: string;
  chatId?: string;
  createdAt: number;
  updatedAt?: number;
  complexity: string;
  estimatedMinutes: number;
  status: 'generating' | 'in_progress' | 'completed' | 'failed' | 'stopped';
  steps: TaskTrackerStep[];
};

export type TaskTrackerPaths = {
  dir: string;
  jsonPath: string;
  mdPath: string;
};

export function safeTaskChatId(chatId?: string | null): string {
  const value = String(chatId || '_global').trim() || '_global';
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getTaskTrackerPaths(chatId?: string | null): TaskTrackerPaths {
  const dir = path.join(TASKS_DIR, safeTaskChatId(chatId));
  return {
    dir,
    jsonPath: path.join(dir, 'task_tracker.json'),
    mdPath: path.join(dir, 'task_tracker.md'),
  };
}

export async function writeTaskTracker(chatId: string | undefined | null, data: TaskTrackerData, markdown: string): Promise<TaskTrackerPaths> {
  const paths = getTaskTrackerPaths(chatId);
  await fs.ensureDir(paths.dir);
  await Promise.all([
    fs.writeJson(paths.jsonPath, data, { spaces: 2 }),
    fs.writeFile(paths.mdPath, markdown, 'utf8'),
  ]);
  return paths;
}

export function readTaskTracker(chatId?: string | null): { data: TaskTrackerData; mtime: number; paths: TaskTrackerPaths } | null {
  const paths = getTaskTrackerPaths(chatId);
  if (!fs.existsSync(paths.jsonPath)) return null;
  const stat = fs.statSync(paths.jsonPath);
  const data = fs.readJsonSync(paths.jsonPath) as TaskTrackerData;
  return { data, mtime: stat.mtimeMs, paths };
}

export function readTaskTrackerMarkdown(chatId?: string | null): { markdown: string; paths: TaskTrackerPaths } | null {
  const paths = getTaskTrackerPaths(chatId);
  if (!fs.existsSync(paths.mdPath)) return null;
  return { markdown: fs.readFileSync(paths.mdPath, 'utf8'), paths };
}

export function writeTaskTrackerJson(chatId: string | undefined | null, data: TaskTrackerData): Promise<void> {
  const paths = getTaskTrackerPaths(chatId);
  return fs.ensureDir(paths.dir).then(() => fs.writeJson(paths.jsonPath, data, { spaces: 2 }));
}

export function trackerToTrace(data: TaskTrackerData, phase: 'generating' | 'generated' | 'progress' | 'complete' = 'progress') {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const completedSteps = steps.filter(step => step.status === 'done').length;
  const totalSteps = steps.length;
  const activeStep = steps.find(step => step.status === 'in_progress') || steps.find(step => step.status === 'pending') || null;

  return {
    type: 'task_plan',
    text: phase === 'generating'
      ? 'Generating task plan'
      : phase === 'generated'
        ? 'Task plan generated'
        : phase === 'complete'
          ? 'Task plan complete'
          : 'Task plan updated',
    phase,
    goal: data.goal,
    status: data.status,
    complexity: data.complexity,
    estimatedMinutes: data.estimatedMinutes,
    completedSteps,
    totalSteps,
    activeStepId: activeStep?.id || null,
    activeStepName: activeStep?.name || null,
    updatedAt: data.updatedAt || data.createdAt || Date.now(),
    steps: steps.map(step => ({
      id: step.id,
      step: step.step,
      name: step.name,
      description: step.description,
      tools: step.tools,
      done_when: step.done_when,
      depends_on: step.depends_on,
      priority: step.priority,
      status: step.status,
      completedAt: step.completedAt,
    })),
  };
}
