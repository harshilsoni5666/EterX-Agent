/**
 * ═══════════════════════════════════════════════════════════════
 * SEMANTIC WORKING MEMORY — Three-Tier Cognitive Memory
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Implements a three-tier memory system inspired by human cognition:
 *
 *   Working Memory  → Current task state (this message)
 *   Episodic Memory  → Session events (72 hours)
 *   Semantic Memory  → Learned knowledge (permanent)
 *
 * KEY INNOVATIONS:
 * 1. Attention-Weighted Slots: Mark facts as "high attention"
 *    so they survive context compression
 * 2. Semantic Indexing: Memory is stored by meaning, not
 *    by timestamp
 * 3. Relevance Scoring: Only inject memories relevant to
 *    the current task
 * 4. User Behavior Model: Track preferences, patterns,
 *    and communication style
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkingMemorySlot {
  id: string;
  content: string;
  attention: 'high' | 'medium' | 'low';
  attentionScore?: number; // 0.0 to 1.0 (activation level)
  category: 'goal' | 'context' | 'constraint' | 'progress' | 'discovery' | 'decision';
  createdAt: number;
  expiresAt?: number;
}

export interface EpisodicEvent {
  id: string;
  type: 'task_start' | 'task_complete' | 'error' | 'discovery' | 'user_feedback' | 'strategy_shift';
  summary: string;
  tools: string[];
  outcome: 'success' | 'failure' | 'partial';
  timestamp: number;
  relevanceKeywords: string[];
}

export interface SemanticFact {
  id: string;
  domain: 'user_preference' | 'tech_knowledge' | 'project_context' | 'error_pattern' | 'workflow';
  fact: string;
  confidence: number;  // 0-1
  learnedAt: number;
  reinforcedCount: number;
  source: string;
}

export interface UserBehaviorModel {
  communicationStyle: 'terse' | 'detailed' | 'casual' | 'formal' | 'mixed';
  techLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  preferredTools: string[];
  frustratedByPattern: string[];
  typicalTaskTypes: string[];
  responsePreference: 'code_first' | 'explanation_first' | 'mixed';
  averageMessageLength: number;
  messageCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_WORKING_SLOTS = 12;
const MAX_EPISODIC_EVENTS = 100;
const MAX_SEMANTIC_FACTS = 200;
const EPISODIC_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class SemanticWorkingMemory {
  // Three tiers
  private workingSlots: WorkingMemorySlot[] = [];
  private episodicMemory: EpisodicEvent[] = [];
  private semanticMemory: SemanticFact[] = [];

  // User model
  private userModel: UserBehaviorModel = {
    communicationStyle: 'mixed',
    techLevel: 'advanced',
    preferredTools: [],
    frustratedByPattern: [],
    typicalTaskTypes: [],
    responsePreference: 'mixed',
    averageMessageLength: 0,
    messageCount: 0,
  };

  // ─── Working Memory (Current Task) ────────────────────────────────────────

  /**
   * Add or update a working memory slot.
   */
  setWorkingSlot(slot: Omit<WorkingMemorySlot, 'id' | 'createdAt'>): void {
    const id = `ws_${slot.category}_${Date.now()}`;
    const existing = this.workingSlots.find(s => s.category === slot.category && s.content === slot.content);
    if (existing) {
      existing.attention = slot.attention;
      existing.attentionScore = slot.attentionScore ?? (slot.attention === 'high' ? 1.0 : slot.attention === 'medium' ? 0.6 : 0.3);
      return;
    }

    this.workingSlots.push({
      id,
      ...slot,
      attentionScore: slot.attentionScore ?? (slot.attention === 'high' ? 1.0 : slot.attention === 'medium' ? 0.6 : 0.3),
      createdAt: Date.now(),
    });

    // Enforce limits — drop lowest-attention slots first
    if (this.workingSlots.length > MAX_WORKING_SLOTS) {
      this.workingSlots.sort((a, b) => {
        const scoreA = a.attentionScore ?? 0.5;
        const scoreB = b.attentionScore ?? 0.5;
        return scoreA - scoreB;
      });
      this.workingSlots = this.workingSlots.slice(-MAX_WORKING_SLOTS);
    }
  }

  /**
   * Decay all working slots that were not matched by the new query.
   */
  decaySlots(query: string): void {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const decayFactor = 0.85;

    this.workingSlots = this.workingSlots.map(s => {
      if (s.attentionScore === undefined) {
        s.attentionScore = s.attention === 'high' ? 1.0 : s.attention === 'medium' ? 0.6 : 0.3;
      }

      const contentLower = s.content.toLowerCase();
      const isMatched = keywords.some(k => contentLower.includes(k));

      if (isMatched) {
        s.attentionScore = Math.min(1.0, s.attentionScore + 0.20);
      } else {
        s.attentionScore = s.attentionScore * decayFactor;
      }

      s.attention = s.attentionScore > 0.8 ? 'high' : s.attentionScore > 0.4 ? 'medium' : 'low';
      return s;
    }).filter(s => (s.attentionScore || 0) >= 0.15); // Evict slots with activation < 0.15
  }

  /**
   * Get all active working memory as context, formatting with activation strength.
   */
  getWorkingContext(): string {
    const active = this.workingSlots.filter(s => {
      if (s.expiresAt && s.expiresAt < Date.now()) return false;
      return true;
    });

    if (active.length === 0) return '';

    // Sort by attention activation level descending
    const sorted = [...active].sort((a, b) => (b.attentionScore || 0) - (a.attentionScore || 0));

    const parts: string[] = ['🧠 WORKING COGNITIVE SLOTS:'];
    for (const slot of sorted) {
      const pct = Math.round((slot.attentionScore || 0.5) * 100);
      parts.push(`  [${slot.category} | load: ${pct}%] ${slot.content}`);
    }

    return parts.join('\n');
  }

  /**
   * Clear working memory (called at start of new task).
   */
  clearWorkingMemory(): void {
    this.workingSlots = [];
  }

  /**
   * Auto-extract working memory from a user message.
   */
  extractFromMessage(message: string): void {
    const lower = message.toLowerCase();

    // Decay slots based on current message keywords before adding new ones
    this.decaySlots(message);

    // Extract execution goals/directives
    const verbMatch = message.match(/\b(compile|test|debug|lint|refactor|build|write|create|fix|verify)\b/i);
    if (verbMatch) {
      this.setWorkingSlot({
        content: `Active execution goal: ${verbMatch[1]} action`,
        attention: 'high',
        category: 'goal',
      });
    }

    // Extract explicit negative constraints
    if (/\b(don't|dont|do not|never|avoid|no)\b/i.test(message)) {
      const constraintMatch = message.match(/(?:don't|dont|do not|never|avoid|no)\s+([a-zA-Z0-9_\-\s]{5,80})(?:\.|$|,)/i);
      if (constraintMatch) {
        this.setWorkingSlot({
          content: `User constraint: do not ${constraintMatch[1].trim()}`,
          attention: 'high',
          category: 'constraint',
        });
      }
    }

    // Extract file references
    const fileRefs = message.match(/\b[\w\-\/\\]+\.\w{1,6}\b/g);
    if (fileRefs) {
      for (const ref of fileRefs.slice(0, 3)) {
        this.setWorkingSlot({
          content: `Referenced file: ${ref}`,
          attention: 'medium',
          category: 'context',
        });
      }
    }

    // Extract target directory paths
    const pathRefs = message.match(/(?:^|\s)(?:[a-zA-Z]:)?[\\/][\w\-.\\/]+\b/g) || message.match(/\b[\w\-.]+[\\/][\w\-.]+\b/g);
    if (pathRefs) {
      for (const p of pathRefs.slice(0, 2)) {
        const cleanPath = p.trim();
        if (!cleanPath.includes('.')) { // Exclude file extensions matching as paths
          this.setWorkingSlot({
            content: `Target path: ${cleanPath}`,
            attention: 'medium',
            category: 'context',
          });
        }
      }
    }

    // Extract tool and stack preferences
    const techCues = message.match(/\b(typescript|javascript|python|rust|golang|next\.?js|react|electron|css|html)\b/i);
    if (techCues) {
      this.setWorkingSlot({
        content: `Active stack preference: ${techCues[1]}`,
        attention: 'medium',
        category: 'constraint',
      });
    }
  }

  // ─── Episodic Memory (Session History) ──────────────────────────────────────

  /**
   * Record an episode.
   * Runs recursive consolidations to prevent identical error logging.
   */
  recordEpisode(event: Omit<EpisodicEvent, 'id' | 'timestamp'>): void {
    this.episodicMemory.push({
      id: `ep_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      ...event,
      timestamp: Date.now(),
    });

    // Consolidate consecutive failures
    this.consolidateEpisodes();

    // Prune old episodes
    const cutoff = Date.now() - EPISODIC_TTL_MS;
    this.episodicMemory = this.episodicMemory.filter(e => e.timestamp > cutoff);
    if (this.episodicMemory.length > MAX_EPISODIC_EVENTS) {
      this.episodicMemory = this.episodicMemory.slice(-MAX_EPISODIC_EVENTS);
    }
  }

  /**
   * Consolidate episodic memory to cluster similar/consecutive failures
   */
  private consolidateEpisodes(): void {
    if (this.episodicMemory.length <= 1) return;

    const consolidated: EpisodicEvent[] = [];
    let i = 0;

    while (i < this.episodicMemory.length) {
      const current = this.episodicMemory[i];
      let j = i + 1;
      const group: EpisodicEvent[] = [current];

      while (j < this.episodicMemory.length) {
        const next = this.episodicMemory[j];
        const isConsecutiveError = current.type === 'error' && next.type === 'error';
        const isSameTools = current.tools.join(',') === next.tools.join(',');

        if (isConsecutiveError && isSameTools) {
          group.push(next);
          j++;
        } else {
          break;
        }
      }

      if (group.length >= 3) {
        const summary = `Repeated errors on [${current.tools.join(', ')}] (${group.length} times): last check was "${current.summary}"`;
        consolidated.push({
          id: current.id,
          type: 'error',
          summary,
          tools: current.tools,
          outcome: 'failure',
          timestamp: group[group.length - 1].timestamp,
          relevanceKeywords: Array.from(new Set(group.flatMap(g => g.relevanceKeywords))),
        });
        console.log(`[SemanticWorkingMemory] 🗜️ Consolidated ${group.length} consecutive errors to save context space.`);
      } else {
        consolidated.push(...group);
      }
      i = j;
    }

    this.episodicMemory = consolidated;
  }

  /**
   * Recall episodes relevant to the current task.
   */
  recallRelevantEpisodes(message: string, limit: number = 5): EpisodicEvent[] {
    const keywords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (keywords.length === 0) return [];

    return this.episodicMemory
      .map(ep => {
        const relevanceScore = ep.relevanceKeywords.filter(k =>
          keywords.some(qk => k.includes(qk) || qk.includes(k))
        ).length / Math.max(1, ep.relevanceKeywords.length);
        return { ...ep, _score: relevanceScore };
      })
      .filter(ep => (ep as any)._score > 0)
      .sort((a, b) => (b as any)._score - (a as any)._score)
      .slice(0, limit);
  }

  /**
   * Get episodic context for the system prompt.
   */
  getEpisodicContext(message: string): string {
    const relevant = this.recallRelevantEpisodes(message, 3);
    if (relevant.length === 0) return '';

    const parts = ['━━━ RECENT RELEVANT EPISODES ━━━'];
    for (const ep of relevant) {
      const ago = this.timeAgo(ep.timestamp);
      parts.push(`• ${ago}: ${ep.summary} [${ep.outcome}] (tools: ${ep.tools.slice(0, 3).join(', ')})`);
    }
    parts.push('━━━ END EPISODES ━━━');
    return parts.join('\n');
  }

  // ─── Semantic Memory (Permanent Knowledge) ──────────────────────────────────

  /**
   * Learn a new semantic fact.
   */
  learnFact(fact: Omit<SemanticFact, 'id' | 'learnedAt' | 'reinforcedCount'>): void {
    const existing = this.semanticMemory.find(f =>
      f.domain === fact.domain && f.fact.toLowerCase().includes(fact.fact.toLowerCase().substring(0, 30))
    );

    if (existing) {
      existing.reinforcedCount++;
      existing.confidence = Math.min(0.99, existing.confidence + 0.05);
      return;
    }

    this.semanticMemory.push({
      id: `sf_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      ...fact,
      learnedAt: Date.now(),
      reinforcedCount: 0,
    });

    if (this.semanticMemory.length > MAX_SEMANTIC_FACTS) {
      this.semanticMemory.sort((a, b) => {
        const scoreA = a.confidence * (1 + a.reinforcedCount * 0.1);
        const scoreB = b.confidence * (1 + b.reinforcedCount * 0.1);
        return scoreB - scoreA;
      });
      this.semanticMemory = this.semanticMemory.slice(0, MAX_SEMANTIC_FACTS);
    }
  }

  /**
   * Recall semantic facts relevant to current context.
   */
  recallFacts(message: string, domain?: SemanticFact['domain']): SemanticFact[] {
    const keywords = message.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (keywords.length === 0) return [];

    return this.semanticMemory
      .filter(f => !domain || f.domain === domain)
      .filter(f => {
        const factLower = f.fact.toLowerCase();
        return keywords.some(k => factLower.includes(k));
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }

  /**
   * Get semantic context for the system prompt.
   */
  getSemanticContext(message: string): string {
    const facts = this.recallFacts(message);
    if (facts.length === 0) return '';

    const parts = ['━━━ LEARNED KNOWLEDGE ━━━'];
    for (const fact of facts) {
      parts.push(`• [${fact.domain}] ${fact.fact} (confidence: ${(fact.confidence * 100).toFixed(0)}%)`);
    }
    parts.push('━━━ END KNOWLEDGE ━━━');
    return parts.join('\n');
  }

  // ─── User Behavior Model ───────────────────────────────────────────────────

  /**
   * Update the user model from a message.
   */
  updateUserModel(message: string): void {
    const words = message.split(/\s+/).length;
    this.userModel.messageCount++;
    this.userModel.averageMessageLength =
      (this.userModel.averageMessageLength * (this.userModel.messageCount - 1) + words) / this.userModel.messageCount;

    // Detect communication style
    if (words < 10) {
      if (this.userModel.communicationStyle === 'mixed') this.userModel.communicationStyle = 'terse';
    } else if (words > 50) {
      if (this.userModel.communicationStyle === 'mixed') this.userModel.communicationStyle = 'detailed';
    }

    // Detect technical keywords and refine tech level
    const advancedTerms = /\b(generic|interface|dependency injection|decorator|multithreading|asynchronous|centroid|pagerank|dag)\b/i;
    const expertTerms = /\b(eigenvalue|divergence|stochastic|entropy|sublinear|hebbian|savitzky|mathematics|matrix)\b/i;
    if (expertTerms.test(message)) {
      this.userModel.techLevel = 'expert';
    } else if (advancedTerms.test(message) && this.userModel.techLevel !== 'expert') {
      this.userModel.techLevel = 'advanced';
    }

    // Response formatting preference
    if (/\b(code|snippet|example|show me code)\b/i.test(message)) {
      this.userModel.responsePreference = 'code_first';
    } else if (/\b(explain|why|how does|rationale|details)\b/i.test(message)) {
      this.userModel.responsePreference = 'explanation_first';
    }

    // Detect frustration
    if (/!{2,}|(?:still|again|already|why|wtf|broken|not working)/i.test(message)) {
      this.userModel.frustratedByPattern.push(message.substring(0, 50));
      if (this.userModel.frustratedByPattern.length > 10) {
        this.userModel.frustratedByPattern = this.userModel.frustratedByPattern.slice(-5);
      }
    }
  }

  /**
   * Get user model context for the system prompt.
   */
  getUserModelContext(): string {
    if (this.userModel.messageCount < 3) return ''; // Not enough data

    const parts: string[] = [];
    parts.push(`User style: ${this.userModel.communicationStyle}, tech level: ${this.userModel.techLevel}`);
    parts.push(`Formatting preference: ${this.userModel.responsePreference}`);

    if (this.userModel.preferredTools.length > 0) {
      parts.push(`Preferred tools: ${this.userModel.preferredTools.join(', ')}`);
    }

    if (this.userModel.frustratedByPattern.length > 0) {
      parts.push(`⚠️ User has shown frustration — be extra precise and proactive`);
    }

    return parts.join('\n');
  }

  // ─── Full Memory Context ───────────────────────────────────────────────────

  /**
   * Build the complete memory context for the system prompt.
   */
  buildFullMemoryContext(message: string): string {
    const sections = [
      this.getWorkingContext(),
      this.getSemanticContext(message),
      this.getEpisodicContext(message),
      this.getUserModelContext(),
    ].filter(Boolean);

    return sections.join('\n\n');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private timeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86400_000)}d ago`;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const workingMemory = new SemanticWorkingMemory();
