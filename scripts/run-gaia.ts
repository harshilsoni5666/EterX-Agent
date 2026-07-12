import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// Load environment variables from .env.local and .env
const repoRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(repoRoot, '.env.local') });
dotenv.config({ path: path.join(repoRoot, '.env') });

interface GaiaTask {
  task_id: string;
  Question: string;
  Level: number;
  'Final answer': string;
  file_name?: string;
  file_path?: string;
}

function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.json': return 'application/json';
    case '.csv': return 'text/csv';
    case '.txt': return 'text/plain';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"']/g, '') // remove punctuation
    .replace(/\s+/g, ' ') // normalize spaces
    .trim();
}

function gradeAnswer(generated: string, expected: string): boolean {
  const normGenerated = normalizeText(generated);
  const normExpected = normalizeText(expected);

  if (normGenerated === normExpected || normGenerated.includes(normExpected)) {
    return true;
  }

  // Float parsing comparison
  const genFloat = parseFloat(normGenerated.match(/-?\d+(\.\d+)?/)?.[0] || '');
  const expFloat = parseFloat(normExpected.match(/-?\d+(\.\d+)?/)?.[0] || '');
  if (!isNaN(genFloat) && !isNaN(expFloat)) {
    return Math.abs(genFloat - expFloat) < 0.01;
  }

  return false;
}

async function runGaiaBenchmark() {
  const { AgentOrchestrator } = await import('../src/lib/agent/orchestrator');
  const { apiKeyPool } = await import('../src/lib/agent/api-key-pool');
  const { buildScopedRuntimeSettings } = await import('../src/lib/agent/runtime-api-keys');

  console.log('==================================================');
  console.log('🤖 EterX GAIA Agent Benchmark Runner');
  console.log('==================================================\n');

  // Discover all Gemini load-balanced keys from process.env
  const keys: string[] = [];
  const primaryKey = process.env.GEMINI_API_KEY;
  if (primaryKey && primaryKey.startsWith('AIza') && primaryKey.length > 20) {
    keys.push(primaryKey);
  }

  for (let i = 1; i <= 100; i++) {
    const val = process.env[`GEMINI_API_KEY_${ i }`];
    if (val && val.startsWith('AIza') && val.length > 20) {
      keys.push(val);
    }
  }

  const uniqueKeys = Array.from(new Set(keys));

  if (uniqueKeys.length === 0) {
    console.error('❌ Error: No valid GEMINI_API_KEY found in process.env or .env.local.');
    console.error('Please define at least one key (e.g. GEMINI_API_KEY or GEMINI_API_KEY_1) so the agent can execute calls.');
    process.exit(1);
  }

  console.log(`🔑 Discovered ${ uniqueKeys.length } Gemini API key(s) for load balancing.`);

  // Initialize EterX key pool with all discovered keys so the agent rotates them under load-balancing
  apiKeyPool.initialize();
  apiKeyPool.setRuntimeKeys(uniqueKeys);

  const defaultModel = process.env.ETERX_THINK_MODEL || process.env.GEMINI_THINK_MODEL || 'gemma-4-31b-it';
  const runtimeSettings = buildScopedRuntimeSettings(
    { gemini: uniqueKeys },
    { gemini: defaultModel }
  );

  // Load GAIA tasks (check metadata.jsonl first, then sample tasks)
  let metadataPath = path.join(repoRoot, 'gaia', 'metadata.jsonl');
  if (!existsSync(metadataPath)) {
    metadataPath = path.join(repoRoot, 'gaia', '2023', 'validation', 'metadata.jsonl');
  }
  const samplePath = path.join(repoRoot, 'gaia', 'sample_gaia_tasks.json');

  let tasks: GaiaTask[] = [];

  if (existsSync(metadataPath)) {
    console.log(`📁 Loading official GAIA dataset from: ${ metadataPath }`);
    const lines = readFileSync(metadataPath, 'utf8').split('\n').filter(Boolean);
    tasks = lines.map(line => JSON.parse(line));
  } else if (existsSync(samplePath)) {
    console.log(`📁 Loading sample GAIA tasks from: ${ samplePath }`);
    tasks = JSON.parse(readFileSync(samplePath, 'utf8'));
  } else {
    console.error('❌ Error: No tasks file found! Please verify sample_gaia_tasks.json exists.');
    process.exit(1);
  }

  // Parse command line arguments
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const taskIdx = args.indexOf('--task');
  const taskIdFilter = taskIdx !== -1 ? args[taskIdx + 1] : null;
  const startIdx = args.indexOf('--start');
  const startOffset = startIdx !== -1 ? parseInt(args[startIdx + 1], 10) : 0;

  if (taskIdFilter) {
    tasks = tasks.filter(t => t.task_id === taskIdFilter);
    console.log(`🎯 Filtered by task ID: ${ taskIdFilter } (${ tasks.length } found)`);
  }
  if (startOffset > 0) {
    tasks = tasks.slice(startOffset);
    console.log(`⏩ Skipped first ${ startOffset } task(s). Starting from task index ${ startOffset }.`);
  }
  if (limit && limit > 0) {
    tasks = tasks.slice(0, limit);
    console.log(`⏳ Limited to next ${ limit } task(s).`);
  }

  console.log(`📊 Total Tasks to Run: ${ tasks.length }`);

  const results = [];
  let correctCount = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    console.log(`\n--------------------------------------------------`);
    console.log(`[Task ${ i + 1 }/${ tasks.length }] ID: ${ task.task_id } (Level ${ task.Level })`);
    console.log(`Question: "${ task.Question }"`);
    if (task.file_name) {
      console.log(`Attachment: ${ task.file_name } (${ task.file_path })`);
    }
    console.log(`--------------------------------------------------`);

    // Prepare attachments / media files
    const mediaFiles = [];
    if (task.file_name && task.file_path) {
      let sourceFilePath = path.join(repoRoot, 'gaia', 'data', task.file_path);
      if (!existsSync(sourceFilePath)) {
        sourceFilePath = path.join(repoRoot, 'gaia', task.file_path);
      }
      const destTempDir = path.join(repoRoot, '.workspaces', 'temp');

      if (!existsSync(destTempDir)) {
        mkdirSync(destTempDir, { recursive: true });
      }

      if (existsSync(sourceFilePath)) {
        const destFilePath = path.join(destTempDir, task.file_name);
        copyFileSync(sourceFilePath, destFilePath);
        mediaFiles.push({
          path: destFilePath,
          name: task.file_name,
          mimeType: getMimeType(task.file_name)
        });
        console.log(`📎 Attachment copied to temp workspace: ${ destFilePath }`);
      } else {
        console.warn(`⚠️ Warning: Attachment file not found at ${ sourceFilePath }. Running without it.`);
      }
    }

    // Set up agent prompt & orchestrator
    const orchestrator = new AgentOrchestrator();
    const prompt = task.Question;
    const history: any[] = [];
    const mode = 'think'; // Use standard reasoning mode
    const chatId = `gaia-run-${ task.task_id }`;

    // Custom trace callback
    const onTrace = (trace: any) => {
      if (trace.type === 'thought_stream') {
        process.stdout.write(trace.text || '');
      } else if (trace.type === 'work_note') {
        console.log(`\n[Note] ${ trace.text }`);
      } else if (trace.type === 'tool_call') {
        console.log(`\n[Tool Call] 🛠️ ${ trace.toolName } args: ${ JSON.stringify(trace.toolArgs) }`);
      } else if (trace.type === 'tool_result') {
        const resStr = JSON.stringify(trace.toolResult);
        const resPreview = resStr.length > 200 ? `${ resStr.substring(0, 200) }...` : resStr;
        console.log(`[Tool Result] 📦 ${ resPreview }`);
      } else if (trace.type === 'error') {
        console.error(`\n[Error] ❌ ${ trace.text || trace.data }`);
      }
    };

    console.log('\n🧠 Agent starting reasoning loop...\n');

    try {
      const response = await orchestrator.executePipeline(
        'gaia-runner-user',
        chatId,
        prompt,
        history,
        onTrace,
        mode,
        {
          disableTaskStore: true,
          runLocation: 'local',
          paths: [repoRoot]
        },
        mediaFiles,
        [], // no imageBackupParts
        'GAIA Assessor',
        undefined,
        runtimeSettings
      );

      const generatedAnswer = response.finalAnswer || '';
      const expectedAnswer = task['Final answer'];
      const passed = gradeAnswer(generatedAnswer, expectedAnswer);

      if (passed) {
        correctCount++;
        console.log(`\n🟢 Task PASSED`);
      } else {
        console.log(`\n🔴 Task FAILED`);
      }

      console.log(`Expected Answer: "${ expectedAnswer }"`);
      console.log(`Generated Answer: "${ generatedAnswer }"`);

      results.push({
        task_id: task.task_id,
        level: task.Level,
        question: task.Question,
        expected: expectedAnswer,
        generated: generatedAnswer,
        passed
      });

    } catch (err: any) {
      console.error(`❌ Task execution crashed:`, err.message);
      results.push({
        task_id: task.task_id,
        level: task.Level,
        question: task.Question,
        expected: task['Final answer'],
        generated: `ERROR: ${ err.message }`,
        passed: false
      });
    }
  }

  // Output Scorecard Report
  const accuracy = (correctCount / tasks.length) * 100;
  console.log(`\n==================================================`);
  console.log(`🏁 GAIA Evaluation Summary`);
  console.log(`==================================================`);
  console.log(`Passed: ${ correctCount }/${ tasks.length } (${ accuracy.toFixed(1) }%)`);

  // Group results by level
  const levels = [1, 2, 3];
  for (const level of levels) {
    const levelTasks = results.filter(r => r.level === level);
    if (levelTasks.length > 0) {
      const levelPassed = levelTasks.filter(r => r.passed).length;
      const levelAccuracy = (levelPassed / levelTasks.length) * 100;
      console.log(`Level ${ level }: ${ levelPassed }/${ levelTasks.length } (${ levelAccuracy.toFixed(1) }%)`);
    }
  }
  console.log(`==================================================`);

  // Save runs report
  const runDir = path.join(repoRoot, 'gaia', 'runs');
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  const reportPath = path.join(runDir, `run_${ Date.now() }.json`);
  writeFileSync(reportPath, JSON.stringify({ summary: { passed: correctCount, total: tasks.length, accuracy }, results }, null, 2));
  console.log(`💾 Full run report saved to: ${ reportPath }\n`);
}

runGaiaBenchmark().catch(err => {
  console.error('Fatal benchmark execution error:', err);
});
