/**
 * EterX — API Key Benchmark & Provider Speed Test
 * Tests response time for each configured provider to find the fastest.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, spinner, c, step, header, line } = require('./banner');

function timedRequest(url, options = {}) {
  const start = Date.now();
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.request(url, {
      method: options.method || 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - start }));
    });
    req.on('error', () => resolve({ status: 0, body: '', ms: Date.now() - start, error: true }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', ms: Date.now() - start, error: true }); });
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function benchmarkGemini(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  return timedRequest(url, {
    body: { contents: [{ parts: [{ text: 'Say hi' }] }], generationConfig: { maxOutputTokens: 5 } },
  });
}

async function benchmarkOpenAI(apiKey, baseUrl = 'https://api.openai.com/v1') {
  return timedRequest(`${baseUrl}/chat/completions`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
  });
}

async function benchmarkGroq(apiKey) {
  return timedRequest('https://api.groq.com/openai/v1/chat/completions', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
  });
}

async function runBenchmark(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  if (!fs.existsSync(envPath)) { fail('No .env.local found'); return; }

  const env = fs.readFileSync(envPath, 'utf8');
  const vars = {};
  env.split('\n').forEach(l => {
    if (l.startsWith('#') || !l.includes('=')) return;
    const [k, ...rest] = l.split('=');
    vars[k.trim()] = rest.join('=').trim();
  });

  const results = [];

  // Gemini
  const geminiKey = vars.GEMINI_API_KEY || vars.GEMINI_API_KEY_1;
  if (geminiKey) {
    const s = spinner('Benchmarking Gemini...');
    const res = await benchmarkGemini(geminiKey);
    if (!res.error && res.status === 200) {
      s.stop(`Gemini: ${res.ms}ms`);
      results.push({ provider: 'Gemini', ms: res.ms, status: 'ok' });
    } else {
      s.fail(`Gemini: failed (${res.status})`);
      results.push({ provider: 'Gemini', ms: res.ms, status: 'fail' });
    }
  }

  // Groq
  if (vars.GROQ_API_KEY) {
    const s = spinner('Benchmarking Groq...');
    const res = await benchmarkGroq(vars.GROQ_API_KEY);
    if (!res.error && res.status === 200) {
      s.stop(`Groq: ${res.ms}ms`);
      results.push({ provider: 'Groq', ms: res.ms, status: 'ok' });
    } else {
      s.fail(`Groq: failed (${res.status})`);
      results.push({ provider: 'Groq', ms: res.ms, status: 'fail' });
    }
  }

  // OpenRouter
  if (vars.OPENROUTER_API_KEY) {
    const s = spinner('Benchmarking OpenRouter...');
    const res = await benchmarkOpenAI(vars.OPENROUTER_API_KEY, 'https://openrouter.ai/api/v1');
    if (!res.error && (res.status === 200 || res.status === 201)) {
      s.stop(`OpenRouter: ${res.ms}ms`);
      results.push({ provider: 'OpenRouter', ms: res.ms, status: 'ok' });
    } else {
      s.fail(`OpenRouter: failed (${res.status})`);
      results.push({ provider: 'OpenRouter', ms: res.ms, status: 'fail' });
    }
  }

  // DeepSeek
  if (vars.DEEPSEEK_API_KEY) {
    const s = spinner('Benchmarking DeepSeek...');
    const res = await benchmarkOpenAI(vars.DEEPSEEK_API_KEY, 'https://api.deepseek.com/v1');
    if (!res.error && res.status === 200) {
      s.stop(`DeepSeek: ${res.ms}ms`);
      results.push({ provider: 'DeepSeek', ms: res.ms, status: 'ok' });
    } else {
      s.fail(`DeepSeek: failed (${res.status})`);
      results.push({ provider: 'DeepSeek', ms: res.ms, status: 'fail' });
    }
  }

  // OpenAI
  if (vars.OPENAI_API_KEY) {
    const s = spinner('Benchmarking OpenAI...');
    const res = await benchmarkOpenAI(vars.OPENAI_API_KEY);
    if (!res.error && res.status === 200) {
      s.stop(`OpenAI: ${res.ms}ms`);
      results.push({ provider: 'OpenAI', ms: res.ms, status: 'ok' });
    } else {
      s.fail(`OpenAI: failed (${res.status})`);
      results.push({ provider: 'OpenAI', ms: res.ms, status: 'fail' });
    }
  }

  // Results table
  if (results.length > 0) {
    line();
    console.log(`\n  ${c.bold}Benchmark Results:${c.reset}\n`);

    const sorted = results.filter(r => r.status === 'ok').sort((a, b) => a.ms - b.ms);
    const maxNameLen = Math.max(...results.map(r => r.provider.length));

    sorted.forEach((r, i) => {
      const bar = '█'.repeat(Math.min(Math.round(r.ms / 50), 40));
      const medal = i === 0 ? ' 🏆' : i === 1 ? ' 🥈' : i === 2 ? ' 🥉' : '';
      const color = r.ms < 500 ? c.green : r.ms < 1500 ? c.yellow : c.red;
      console.log(`  ${r.provider.padEnd(maxNameLen)}  ${color}${String(r.ms).padStart(5)}ms${c.reset}  ${c.cyan}${bar}${c.reset}${medal}`);
    });

    const failed = results.filter(r => r.status === 'fail');
    if (failed.length > 0) {
      console.log();
      failed.forEach(r => console.log(`  ${r.provider.padEnd(maxNameLen)}  ${c.red}FAILED${c.reset}`));
    }

    if (sorted.length > 0) {
      console.log(`\n  ${c.green}${c.bold}Fastest: ${sorted[0].provider} (${sorted[0].ms}ms)${c.reset}\n`);
    }
  } else {
    warn('No providers configured to benchmark');
  }
}

module.exports = { runBenchmark };
