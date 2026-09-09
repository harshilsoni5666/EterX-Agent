/**
 * ═══════════════════════════════════════════════════════════════
 * PRECISION OUTPUT ENGINE — Polished Deliverables
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Records descriptive metrics without rewriting or judging response style.
 * Content labels and word counts do not establish that a response needs
 * a table, headings, examples, or a diagram; that depends on user intent.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OutputAnalysis {
  contentType: 'code' | 'explanation' | 'data' | 'list' | 'report' | 'conversation' | 'mixed';
  wordCount: number;
  codeBlockCount: number;
  hasStructuredData: boolean;
  hasDiagrams: boolean;
  bloatScore: number;  // Compatibility field; wording is no longer scored.
  suggestions: string[];
}

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

    // Descriptive metrics only. Wording and layout are model decisions,
    // not reasons for a phrase blacklist or a formatting correction pass.

    return {
      contentType,
      wordCount,
      codeBlockCount: codeBlocks.length,
      hasStructuredData: hasTable,
      hasDiagrams: hasMermaid,
      bloatScore: 0,
      suggestions: [],
    };
  }

  /**
   * Remove bloat from output text.
   */
  deBloat(text: string): string {
    // Quality advice belongs before generation. Global text substitutions
    // corrupt code indentation, quoted content, and exact requested wording.
    return text;
  }

  /** Kept for callers that previously requested automatic style corrections. */
  suggestFormatting(_analysis: OutputAnalysis): string | null {
    return null;
  }

  buildQualityDirective(_analysis: OutputAnalysis): string {
    return '';
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const precisionOutput = new PrecisionOutputEngine();
