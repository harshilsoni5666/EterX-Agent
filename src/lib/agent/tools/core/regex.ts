import { z } from 'zod';
import { ToolDefinition } from '../../schemas';

/**
 * Advanced Regex & Text Processing Tool
 * 
 * Pattern matching, extraction, replacement, splitting,
 * and text transformation — the Swiss Army knife for text.
 */
export const regexTool: ToolDefinition = {
  name: 'regex_text_processor',
  description: `Advanced text processing with regex: match, extract, replace, split, validate patterns, count occurrences, and transform text. Use this for parsing logs, extracting data from text, cleaning strings, and pattern-based transformations.`,
  category: 'core',
  inputSchema: z.object({
    operation: z.enum([
      'match', 'match_all', 'replace', 'split', 'extract_groups',
      'test', 'count', 'find_positions',
      'to_uppercase', 'to_lowercase', 'to_title_case',
      'trim_lines', 'remove_duplicates', 'sort_lines',
      'extract_emails', 'extract_urls', 'extract_numbers',
      'word_count', 'char_count', 'line_count'
    ]).describe('Text processing operation'),
    text: z.string().describe('Input text to process'),
    pattern: z.string().optional().describe('Regex pattern (without delimiters)'),
    replacement: z.string().optional().describe('Replacement string (for replace operation)'),
    flags: z.string().optional().default('gi').describe('Regex flags (default: gi)')
  }),
  outputSchema: z.object({
    result: z.any(),
    success: z.boolean()
  }),
  execute: async (input: any) => {
    try {
      const text = input.text || '';

      switch (input.operation) {
        case 'match': {
          const regex = new RegExp(input.pattern, input.flags || 'i');
          const match = text.match(regex);
          return { success: true, result: match ? { match: match[0], index: match.index, groups: match.groups } : null };
        }
        case 'match_all': {
          const regex = new RegExp(input.pattern, input.flags?.includes('g') ? input.flags : (input.flags || '') + 'g');
          const matches = [...text.matchAll(regex)].map(m => ({ match: m[0], index: m.index, groups: m.slice(1) }));
          return { success: true, result: matches, count: matches.length };
        }
        case 'replace': {
          const regex = new RegExp(input.pattern, input.flags || 'gi');
          const result = text.replace(regex, input.replacement || '');
          return { success: true, result };
        }
        case 'split': {
          const regex = new RegExp(input.pattern || '\\n', input.flags || '');
          return { success: true, result: text.split(regex) };
        }
        case 'extract_groups': {
          const regex = new RegExp(input.pattern, input.flags?.includes('g') ? input.flags : (input.flags || '') + 'g');
          const groups = [...text.matchAll(regex)].map(m => m.groups || m.slice(1));
          return { success: true, result: groups, count: groups.length };
        }
        case 'test': {
          const regex = new RegExp(input.pattern, input.flags || 'i');
          return { success: true, result: regex.test(text) };
        }
        case 'count': {
          const regex = new RegExp(input.pattern, 'g');
          const matches = text.match(regex);
          return { success: true, result: matches ? matches.length : 0 };
        }
        case 'find_positions': {
          const regex = new RegExp(input.pattern, 'g');
          const positions: Array<{ index: number, match: string }> = [];
          let m;
          while ((m = regex.exec(text)) !== null) {
            positions.push({ index: m.index, match: m[0] });
          }
          return { success: true, result: positions };
        }
        case 'to_uppercase': return { success: true, result: text.toUpperCase() };
        case 'to_lowercase': return { success: true, result: text.toLowerCase() };
        case 'to_title_case': return { success: true, result: text.replace(/\w\S*/g, (t: string) => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase()) };
        case 'trim_lines': return { success: true, result: text.split('\n').map((l: string) => l.trim()).filter((l: string) => l).join('\n') };
        case 'remove_duplicates': return { success: true, result: Array.from(new Set(text.split('\n'))).join('\n') };
        case 'sort_lines': return { success: true, result: text.split('\n').sort().join('\n') };
        case 'extract_emails': {
          const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
          return { success: true, result: Array.from(new Set(emails)), count: emails.length };
        }
        case 'extract_urls': {
          const urls = text.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
          return { success: true, result: Array.from(new Set(urls)), count: urls.length };
        }
        case 'extract_numbers': {
          const numbers = text.match(/-?\d+\.?\d*/g) || [];
          return { success: true, result: numbers.map(Number), count: numbers.length };
        }
        case 'word_count': return { success: true, result: text.split(/\s+/).filter(Boolean).length };
        case 'char_count': return { success: true, result: { total: text.length, noSpaces: text.replace(/\s/g, '').length } };
        case 'line_count': return { success: true, result: text.split('\n').length };
        default:
          return { success: false, result: 'Unknown operation' };
      }
    } catch (error: any) {
      return { success: false, result: `Regex error: ${error.message}` };
    }
  }
};
