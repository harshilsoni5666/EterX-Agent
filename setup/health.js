/**
 * EterX — Post-Install Health Check & API Key Validation
 * Tests every configured provider key actually works before declaring success.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, spinner, c } = require('./banner');
const { getDiskFreeGB } = require('./detect');

/**
 * Make a simple HTTPS/HTTP request — zero deps
 */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

/**
 * Test a Gemini API key
 */
async function testGeminiKey(apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = await request(url, { method: 'GET' });
    return res.status === 200;
  } catch { return false; }
}

/**
 * Test an OpenAI-compatible endpoint
 */
async function testOpenAIKey(apiKey, baseUrl = 'https://api.openai.com/v1') {
  try {
    const res = await request(`${baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return res.status === 200;
  } catch { return false; }
}

/**
 * Test Anthropic key
 */
async function testAnthropicKey(apiKey) {
  try {
    const res = await request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: 'claude-haiku-3.5-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    // 200 = works, 400 = key valid but bad request (still good), 401 = bad key
    return res.status !== 401 && res.status !== 403;
  } catch { return false; }
}

/**
 * Test Groq key
 */
async function testGroqKey(apiKey) {
  return testOpenAIKey(apiKey, 'https://api.groq.com/openai/v1');
}

/**
 * Test Tavily key
 */
async function testTavilyKey(apiKey) {
  try {
    const res = await request('https://api.tavily.com/search', {
      body: { api_key: apiKey, query: 'test', max_results: 1 },
    });
    return res.status === 200;
  } catch { return false; }
}

/**
 * Test if a local server is reachable (LM Studio, Ollama)
 */
async function testLocalEndpoint(url) {
  try {
    const res = await request(`${url}/models`, { method: 'GET' });
    return res.status === 200;
  } catch { return false; }
}

/**
 * Test internet connectivity
 */
async function testInternet() {
  try {
    const res = await request('https://httpbin.org/get', { method: 'GET' });
    return res.status === 200;
  } catch { return false; }
}

/**
 * Check disk space (returns GB free)
 */
function checkDiskSpace(dir) {
  return getDiskFreeGB(dir);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    const index = cursor++;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

/**
 * Run full health check on the installation
 */
async function runHealthCheck(projectRoot) {
  const results = { passed: 0, failed: 0, warnings: 0, details: [] };

  // 1. Internet
  const s1 = spinner('Checking internet connectivity...');
  const internet = await testInternet();
  if (internet) { s1.stop('Internet connected'); results.passed++; }
  else { s1.fail('No internet'); results.warnings++; }

  // 2. Disk space
  const diskGB = checkDiskSpace(projectRoot);
  if (diskGB > 2) { ok(`Disk space: ${diskGB.toFixed(1)} GB free`); results.passed++; }
  else if (diskGB > 0.5) { warn(`Low disk: ${diskGB.toFixed(1)} GB free`); results.warnings++; }
  else if (diskGB > 0) { fail(`Very low disk: ${diskGB.toFixed(1)} GB`); results.failed++; }

  // 3. node_modules
  const nmPath = path.join(projectRoot, 'node_modules');
  if (fs.existsSync(nmPath)) { ok('node_modules present'); results.passed++; }
  else { fail('node_modules missing — run: node setup.js --repair'); results.failed++; }

  // 4. .env.local
  const envPath = path.join(projectRoot, '.env.local');
  if (!fs.existsSync(envPath)) {
    fail('.env.local missing — run: node setup.js --reconfigure');
    results.failed++;
    return results;
  }
  ok('.env.local present');
  results.passed++;

  // 5. Test API keys from .env.local
  const envContent = fs.readFileSync(envPath, 'utf8');
  const envVars = {};
  envContent.split('\n').forEach(line => {
    if (line.startsWith('#') || !line.includes('=')) return;
    const [key, ...rest] = line.split('=');
    envVars[key.trim()] = rest.join('=').trim();
  });

  // Gemini keys
  const geminiKeys = Object.entries(envVars)
    .filter(([k]) => k.startsWith('GEMINI_API_KEY'))
    .map(([k, v]) => ({ name: k, value: v }))
    .filter(e => e.value);

  if (geminiKeys.length > 0) {
    const s = spinner(`Testing ${geminiKeys.length} Gemini key(s)...`);
    const keyResults = await mapWithConcurrency(geminiKeys, 5, (key) => testGeminiKey(key.value));
    const validCount = keyResults.filter(Boolean).length;
    if (validCount === geminiKeys.length) {
      s.stop(`All ${validCount} Gemini keys valid`);
      results.passed++;
    } else if (validCount > 0) {
      s.stop(`${validCount}/${geminiKeys.length} Gemini keys valid`);
      results.warnings++;
    } else {
      s.fail('No valid Gemini keys');
      results.failed++;
    }
  }

  // Groq
  if (envVars.GROQ_API_KEY) {
    const s = spinner('Testing Groq key...');
    if (await testGroqKey(envVars.GROQ_API_KEY)) { s.stop('Groq key valid'); results.passed++; }
    else { s.fail('Groq key invalid'); results.warnings++; }
  }

  // Anthropic
  if (envVars.ANTHROPIC_API_KEY) {
    const s = spinner('Testing Anthropic key...');
    if (await testAnthropicKey(envVars.ANTHROPIC_API_KEY)) { s.stop('Anthropic key valid'); results.passed++; }
    else { s.fail('Anthropic key invalid'); results.warnings++; }
  }

  // OpenRouter
  if (envVars.OPENROUTER_API_KEY) {
    const s = spinner('Testing OpenRouter key...');
    if (await testOpenAIKey(envVars.OPENROUTER_API_KEY, 'https://openrouter.ai/api/v1')) { s.stop('OpenRouter key valid'); results.passed++; }
    else { s.fail('OpenRouter key invalid'); results.warnings++; }
  }

  // Tavily
  const tavilyKeys = Object.entries(envVars)
    .filter(([k]) => k.startsWith('TAVILY_API_KEY'))
    .map(([, v]) => v)
    .filter(Boolean);

  if (tavilyKeys.length > 0) {
    const s = spinner('Testing Tavily key...');
    if (await testTavilyKey(tavilyKeys[0])) { s.stop('Tavily search working'); results.passed++; }
    else { s.fail('Tavily key invalid'); results.warnings++; }
  }

  // 6. Local storage
  const wsPath = path.join(projectRoot, '.workspaces');
  if (fs.existsSync(wsPath)) { ok('Local storage initialized'); results.passed++; }
  else { warn('Local storage not set up'); results.warnings++; }

  // 7. Next.js build check
  const nextDir = path.join(projectRoot, '.next');
  if (fs.existsSync(nextDir)) { ok('Next.js build cache present'); results.passed++; }
  else { info('No Next.js build cache (first run will be slower)'); }

  return results;
}

module.exports = { runHealthCheck, testGeminiKey, testOpenAIKey, testAnthropicKey, testGroqKey, testTavilyKey, testInternet, checkDiskSpace };
