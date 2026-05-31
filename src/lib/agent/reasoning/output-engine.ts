/**
 * ═══════════════════════════════════════════════════════════════
 * PRECISION OUTPUT ENGINE — Polished Deliverables
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Transforms raw model output into polished deliverables:
 * 1. Format Matching: Match format to content type
 * 2. Completeness Scoring: Score 0-100% vs original request
 * 3. Anti-Bloat: Remove filler phrases & disclaimers
 * 4. Evidence Linking: Link claims to tool evidence
 * 5. Smart Summarization: When needed, auto-summarize
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OutputAnalysis {
  contentType: 'code' | 'explanation' | 'data' | 'list' | 'report' | 'conversation' | 'mixed';
  wordCount: number;
  codeBlockCount: number;
  hasStructuredData: boolean;
  hasDiagrams: boolean;
  bloatScore: number;  // 0-1 (higher = more bloat)
  suggestions: string[];
}

// ─── Bloat Patterns ───────────────────────────────────────────────────────────

const BLOAT_PATTERNS: Array<{ pattern: RegExp; replacement: string; severity: number }> = [
  // AI disclaimers
  { pattern: /\bAs an AI(?:\s+language model)?(?:,\s*)?/gi, replacement: '', severity: 3 },
  { pattern: /\bI(?:'d| would) be happy to\b/gi, replacement: '', severity: 2 },
  { pattern: /\bCertainly!?\s*/gi, replacement: '', severity: 2 },
  { pattern: /\bAbsolutely!?\s*/gi, replacement: '', severity: 1 },
  { pattern: /\bSure!?\s*(?:thing!?\s*)?/gi, replacement: '', severity: 1 },
  { pattern: /\bOf course!?\s*/gi, replacement: '', severity: 1 },
  { pattern: /\bGreat question!?\s*/gi, replacement: '', severity: 2 },
  { pattern: /\bThat's a (?:great|good|interesting|excellent) (?:question|point|idea)!?\s*/gi, replacement: '', severity: 2 },

  // Filler phrases
  { pattern: /\bIt(?:'s| is) (?:worth noting|important to note|notable) that\s*/gi, replacement: '', severity: 2 },
  { pattern: /\bAs (?:you (?:can see|mentioned|noted)|I mentioned)\s*,?\s*/gi, replacement: '', severity: 1 },
  { pattern: /\bLet me (?:explain|elaborate|clarify|break (?:this|it) down)\s*[.:]\s*/gi, replacement: '', severity: 2 },
  { pattern: /\bHere(?:'s| is) (?:a |an )?(?:brief |quick )?(?:overview|summary|explanation|breakdown)\s*(?:of |:)\s*/gi, replacement: '', severity: 1 },
  { pattern: /\bI(?:'ll| will) (?:now |)(?:go ahead and |)(?:help you |)/gi, replacement: '', severity: 2 },

  // Closing fillers
  { pattern: /\bFeel free to (?:ask|reach out|let me know)\b[^.]*\.?\s*/gi, replacement: '', severity: 3 },
  { pattern: /\bDon't hesitate to\b[^.]*\.?\s*/gi, replacement: '', severity: 3 },
  { pattern: /\bI hope this (?:helps|is useful|answers|clarifies)\b[^.]*\.?\s*/gi, replacement: '', severity: 3 },
  { pattern: /\bLet me know if you (?:need|have|want)\b[^.]*\.?\s*/gi, replacement: '', severity: 2 },
  { pattern: /\bIs there anything else\b[^.?]*[.?]\s*/gi, replacement: '', severity: 3 },
  { pattern: /\bIf you have (?:any )?(?:more |further )?questions\b[^.]*\.?\s*/gi, replacement: '', severity: 3 },

  // Hedging
  { pattern: /\bbasically(?:,\s*)?/gi, replacement: '', severity: 1 },
  { pattern: /\bessentially(?:,\s*)?/gi, replacement: '', severity: 1 },
];

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class PrecisionOutputEngine {
  /**
   * Analyze output content type and quality.
   */
  analyze(text: string): OutputAnalysis {
    const codeBlocks = (text.match(/```[\s\S]*?```/g) || []);
    const wordCount = text.split(/\s+/).length;
    const hasTable = /\|.+\|.+\|/m.test(text);
    const hasMermaid = /```mermaid/i.test(text);
    const hasList = /^\s*[-*•]\s/m.test(text) || /^\s*\d+[.)]\s/m.test(text);

    // Determine content type
    let contentType: OutputAnalysis['contentType'] = 'mixed';
    if (codeBlocks.length > 0 && codeBlocks.join('').length > text.length * 0.5) {
      contentType = 'code';
    } else if (hasTable || /\b(total|average|sum|count|min|max)\b/i.test(text)) {
      contentType = 'data';
    } else if (hasList && !codeBlocks.length) {
      contentType = 'list';
    } else if (wordCount > 200 && text.includes('#')) {
      contentType = 'report';
    } else if (wordCount < 50 && !codeBlocks.length) {
      contentType = 'conversation';
    } else if (codeBlocks.length === 0) {
      contentType = 'explanation';
    }

    // Calculate bloat score
    let bloatHits = 0;
    for (const { pattern, severity } of BLOAT_PATTERNS) {
      if (pattern.test(text)) {
        bloatHits += severity;
        pattern.lastIndex = 0; // Reset regex state
      }
    }
    const bloatScore = Math.min(1, bloatHits / 15);

    // Generate suggestions
    const suggestions: string[] = [];
    if (bloatScore > 0.3) suggestions.push('Remove filler phrases and disclaimers');
    if (contentType === 'code' && codeBlocks.length > 0 && !text.includes('```')) {
      suggestions.push('Add language tags to code blocks');
    }
    if (contentType === 'data' && !hasTable) {
      suggestions.push('Consider using a markdown table for structured data');
    }

    return {
      contentType,
      wordCount,
      codeBlockCount: codeBlocks.length,
      hasStructuredData: hasTable,
      hasDiagrams: hasMermaid,
      bloatScore,
      suggestions,
    };
  }

  /**
   * Remove bloat from output text.
   */
  deBloat(text: string): string {
    let cleaned = text;
    for (const { pattern, replacement } of BLOAT_PATTERNS) {
      cleaned = cleaned.replace(pattern, replacement);
      pattern.lastIndex = 0; // Reset regex state after replace
    }

    // Clean up double spaces and empty lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    cleaned = cleaned.replace(/  +/g, ' ');
    cleaned = cleaned.trim();

    return cleaned;
  }

  /**
   * Format-match: suggest better formatting for the content.
   */
  suggestFormatting(analysis: OutputAnalysis): string | null {
    switch (analysis.contentType) {
      case 'data':
        if (!analysis.hasStructuredData) {
          return 'Consider formatting this data as a markdown table for clarity.';
        }
        break;
      case 'explanation':
        if (analysis.wordCount > 300 && !analysis.hasDiagrams) {
          return 'Consider adding a Mermaid diagram to visualize the architecture/flow.';
        }
        break;
      case 'report':
        if (analysis.wordCount > 500 && analysis.codeBlockCount === 0) {
          return 'Consider adding code examples or a table of contents for this long report.';
        }
        break;
    }
    return null;
  }

  /**
   * Build output quality directive for the system prompt.
   * Called when the model's output needs improvement.
   */
  buildQualityDirective(analysis: OutputAnalysis): string {
    if (analysis.bloatScore < 0.2 && analysis.suggestions.length === 0) return '';

    const parts: string[] = ['[OUTPUT QUALITY CHECK]'];
    if (analysis.bloatScore > 0.3) {
      parts.push('⚠️ Your output contains filler phrases. Be direct. Remove disclaimers, hedging, and "let me know" closings.');
    }
    for (const suggestion of analysis.suggestions) {
      parts.push(`→ ${suggestion}`);
    }
    const formatting = this.suggestFormatting(analysis);
    if (formatting) parts.push(`→ ${formatting}`);

    parts.push('[END OUTPUT CHECK]');
    return parts.join('\n');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const precisionOutput = new PrecisionOutputEngine();
