import assert from 'node:assert/strict';
import {
  applyRuntimeProviderBaseURLs,
  getProviderBaseURL,
  normalizeProviderBaseURL,
} from '../src/lib/agent/provider-runtime';

function testLocalBaseURLNormalization(): void {
  assert.equal(
    normalizeProviderBaseURL('ollama', 'http://localhost:11434'),
    'http://localhost:11434/v1',
  );
  assert.equal(
    normalizeProviderBaseURL('ollama', 'http://localhost:11434/api/tags'),
    'http://localhost:11434/v1',
  );
  assert.equal(
    normalizeProviderBaseURL('lmstudio', 'http://127.0.0.1:1234/v1/chat/completions'),
    'http://127.0.0.1:1234/v1',
  );
  assert.equal(
    normalizeProviderBaseURL('lmstudio', 'http://127.0.0.1:1234/api/v1/models'),
    'http://127.0.0.1:1234/v1',
  );
  assert.equal(
    normalizeProviderBaseURL('vllm', 'http://gpu-box:8000/v1/models'),
    'http://gpu-box:8000/v1',
  );
  assert.equal(
    normalizeProviderBaseURL('llamacpp', 'http://127.0.0.1:8080'),
    'http://127.0.0.1:8080/v1',
  );
}

function testRemoteAndCustomPaths(): void {
  assert.equal(
    normalizeProviderBaseURL('openrouter', 'https://openrouter.ai/api/v1/chat/completions'),
    'https://openrouter.ai/api/v1',
  );
  assert.equal(
    normalizeProviderBaseURL('custom', 'https://gateway.example/openai/v1/models'),
    'https://gateway.example/openai/v1',
  );
  assert.equal(
    normalizeProviderBaseURL('custom', 'https://gateway.example/api/openai'),
    'https://gateway.example/api/openai',
  );
}

function testRuntimeOverrideUsesTheNormalizedPath(): void {
  applyRuntimeProviderBaseURLs({ ollama: 'http://localhost:11434/api/tags' });
  assert.equal(getProviderBaseURL('ollama'), 'http://localhost:11434/v1');

  applyRuntimeProviderBaseURLs({});
  assert.equal(getProviderBaseURL('ollama'), 'http://127.0.0.1:11434/v1');
}

testLocalBaseURLNormalization();
testRemoteAndCustomPaths();
testRuntimeOverrideUsesTheNormalizedPath();
console.log('provider-runtime integration tests passed');
