import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { workspaceCodeThemes } from './code-theme';

const languages = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  json: () => import('@shikijs/langs/json'),
  python: () => import('@shikijs/langs/python'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  bash: () => import('@shikijs/langs/bash'),
  sql: () => import('@shikijs/langs/sql'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  cpp: () => import('@shikijs/langs/cpp'),
};
const highlighter = createHighlighterCore({
  engine: createJavaScriptRegexEngine({ forgiving: true }),
  themes: workspaceCodeThemes,
  langs: [],
});
const loaded = new Map<string, Promise<void>>();

self.onmessage = async (event: MessageEvent<{ id: number; content: string; language: string }>) => {
  const { id, content, language } = event.data;
  try {
    const loader = languages[language as keyof typeof languages];
    if (!loader || content.length > 300000) { self.postMessage({ id, tokens: null }); return; }
    const engine = await highlighter;
    if (!loaded.has(language)) loaded.set(language, loader().then(module => engine.loadLanguage(module.default)));
    await loaded.get(language);
    const tokens = engine.codeToTokensWithThemes(content, { lang: language, themes: { light: 'eterx-light', dark: 'eterx-dark' }, tokenizeMaxLineLength: 2000, tokenizeTimeLimit: 20 });
    self.postMessage({ id, tokens: tokens.map(line => line.map(token => ({ text: token.content, light: token.variants.light.color, dark: token.variants.dark.color }))) });
  } catch { self.postMessage({ id, tokens: null }); }
};
