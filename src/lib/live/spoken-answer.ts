type SpeechDetail = 'brief' | 'balanced' | 'detailed';

const SPEECH_LENGTH: Record<SpeechDetail, number> = {
  brief: 480,
  balanced: 1000,
  detailed: 2400,
};

function tableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell.trim()));
}

/**
 * A spoken excerpt of the authored answer, not an invented semantic summary.
 * Preserve the full Markdown in chat; skip syntax that only makes sense there.
 * Unclosed fences are intentionally omitted through the end of the input.
 */
export function formatLiveSpeech(markdown: string, detail: SpeechDetail = 'balanced'): string {
  const source = String(markdown || '').trim();
  if (!source) return '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const prose: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let mathEnd: string | null = null;
  let inTable = false;
  let omitted = false;

  for (let index = 0; index < lines.length; index += 1) {
    // Quoted/list-contained blocks have the same spoken treatment as top-level
    // blocks. Do not change the original Markdown or its displayed content.
    const line = lines[index].replace(/^\s*(?:>\s*)+/, '').trim();
    const delimiter = /^(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker
        && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      omitted = true;
      prose.push('');
      continue;
    }
    if (mathEnd) {
      if (line.includes(mathEnd)) mathEnd = null;
      continue;
    }
    const mathStart = line.startsWith('$$') ? '$$' : line.startsWith('\\[') ? '\\]' : null;
    if (mathStart) {
      if (!line.slice(2).includes(mathStart)) mathEnd = mathStart;
      omitted = true;
      prose.push('');
      continue;
    }
    if (inTable) {
      if (line && /(^|[^\\])\|/.test(line)) continue;
      inTable = false;
    }
    if (index + 1 < lines.length && tableSeparator(lines[index + 1].replace(/^\s*(?:>\s*)+/, ''))) {
      inTable = true;
      omitted = true;
      prose.push('');
      index += 1; // Omit both the header and its delimiter row.
      continue;
    }
    if (/^\s*\[[^\]]+\]:/.test(line) || /^(?:[-*_]\s*){3,}$/.test(line)) continue;
    const block = /^(?:#{1,6}\s|(?:[-+*]|\d+[.)])\s)/.test(line);
    const content = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/\s+#+$/, '')
      .replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '');
    if (block) prose.push('', content, '');
    else prose.push(content);
  }

  let text = prose.join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-z][\w:-]*)(?:\s[^<>]*?)?>|<\/[a-z][\w:-]*\s*>/gi, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, () => { omitted = true; return ''; })
    .replace(/\[([^\]]+)\]\((?:<[^>]*>|[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<?(?:https?:\/\/|www\.)[^\s<>]+>?/gi, () => { omitted = true; return ''; })
    .replace(/\\\([\s\S]*?\\\)/g, () => { omitted = true; return ''; })
    .replace(/(\*{1,3}|_{1,3}|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\\([\\`*{}[\]()#+.!_|>~-])/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

  // Soft line wraps stay in the same sentence. Separate paragraphs and list
  // items have a spoken pause without changing identifiers or numeric values.
  text = text.split(/\n\s*\n/).map(paragraph => paragraph.replace(/\n/g, ' ').trim()).filter(Boolean)
    .map(paragraph => /[.!?…。！？:;]$/.test(paragraph) ? paragraph : `${paragraph}.`).join(' ')
    .replace(/\s+/g, ' ').trim();
  const limit = SPEECH_LENGTH[detail];
  if (text.length > limit) {
    const excerpt = text.slice(0, limit);
    const sentenceEnd = [...excerpt.matchAll(/[.!?。！？](?:\s|$)/g)].at(-1)?.index;
    const wordEnd = excerpt.lastIndexOf(' ');
    text = sentenceEnd !== undefined && sentenceEnd >= limit / 2
      ? excerpt.slice(0, sentenceEnd + 1)
      : `${excerpt.slice(0, wordEnd >= limit / 2 ? wordEnd : limit).trimEnd()}…`;
    omitted = true;
  }
  return [text, omitted ? 'The full answer is in the chat.' : ''].filter(Boolean).join(' ');
}
