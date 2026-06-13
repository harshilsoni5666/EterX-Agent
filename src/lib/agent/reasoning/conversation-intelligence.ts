/**
 * ═══════════════════════════════════════════════════════════════
 * CONVERSATION INTELLIGENCE V2 — Deep Dialogue Understanding
 * ═══════════════════════════════════════════════════════════════
 *
 * WHAT THIS DOES:
 * Makes the agent understand conversation at a DEEP level:
 *
 * 1. Emotional State Tracking: Detect frustration, urgency,
 *    satisfaction from message patterns
 * 2. Intent Evolution: Track how user intent evolves across
 *    messages (exploring → deciding → building)
 * 3. Implicit Request Detection: "Make it look better" →
 *    analyze state, identify specific improvements
 * 4. Context Resolution: When user says "fix that thing",
 *    accurately resolve what "that thing" is
 * 5. Proactive Suggestions: After task, suggest next steps
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type EmotionalState = 'neutral' | 'positive' | 'frustrated' | 'urgent' | 'confused' | 'appreciative';
export type IntentPhase = 'exploring' | 'deciding' | 'building' | 'debugging' | 'reviewing' | 'deploying';

export interface ConversationSnapshot {
  emotionalState: EmotionalState;
  emotionalIntensity: number;  // 0-1
  intentPhase: IntentPhase;
  activeTopics: string[];
  recentReferences: ContextReference[];
  conversationTurn: number;
  avgResponseTime: number;
  frustrationLevel: number;  // 0-1
  urgencyLevel: number;      // 0-1
}

export interface ContextReference {
  type: 'file' | 'tool' | 'concept' | 'error' | 'feature' | 'output';
  value: string;
  mentionedAt: number;
  lastReferencedAt: number;
  referenceCount: number;
}

export interface ProactiveSuggestion {
  text: string;
  confidence: number;
  category: 'next_step' | 'improvement' | 'warning' | 'optimization';
}

// ─── Emotion Detection Patterns ───────────────────────────────────────────────

const EMOTION_PATTERNS: Array<{ pattern: RegExp; state: EmotionalState; intensity: number }> = [
  // Frustration
  { pattern: /!{2,}/, state: 'frustrated', intensity: 0.7 },
  { pattern: /\b(wtf|omg|ugh|damn|shit|hell)\b/i, state: 'frustrated', intensity: 0.8 },
  { pattern: /\b(still|again|already told|not working|broken again|why)\b/i, state: 'frustrated', intensity: 0.6 },
  { pattern: /\b(doesn't work|not right|wrong|bad|terrible|horrible)\b/i, state: 'frustrated', intensity: 0.5 },
  { pattern: /\b(I said|I already|I told you|I mentioned)\b/i, state: 'frustrated', intensity: 0.7 },

  // Urgency
  { pattern: /\b(urgent|asap|hurry|quick|fast|immediately|now|rush|deadline)\b/i, state: 'urgent', intensity: 0.8 },
  { pattern: /\b(need this|have to|must|critical|priority)\b/i, state: 'urgent', intensity: 0.6 },

  // Positive
  { pattern: /\b(thanks?|thank you|great|awesome|perfect|excellent|amazing|love it|nice|well done)\b/i, state: 'positive', intensity: 0.7 },
  { pattern: /\b(good job|exactly|that's it|works|working)\b/i, state: 'positive', intensity: 0.5 },
  { pattern: /\b(❤️|👍|🎉|💯|🔥|✨)\b/, state: 'positive', intensity: 0.6 },

  // Confused
  { pattern: /\b(confused|don't understand|what do you mean|huh|what\?|how)\b/i, state: 'confused', intensity: 0.6 },
  { pattern: /\?{2,}/, state: 'confused', intensity: 0.5 },

  // Appreciative
  { pattern: /\b(bro|brother|love you|free will|your best|go all out)\b/i, state: 'appreciative', intensity: 0.8 },
  { pattern: /\b(amazing work|incredible|unbelievable|mindblown|genius)\b/i, state: 'appreciative', intensity: 0.9 },
];

// ─── Intent Phase Patterns ────────────────────────────────────────────────────

const INTENT_PATTERNS: Array<{ pattern: RegExp; phase: IntentPhase; weight: number }> = [
  // Exploring
  { pattern: /\b(what is|how does|explain|tell me|show me|describe|overview)\b/i, phase: 'exploring', weight: 8 },
  { pattern: /\b(research|investigate|compare|options|alternatives)\b/i, phase: 'exploring', weight: 7 },

  // Deciding
  { pattern: /\b(should I|which|best way|recommend|pros and cons|trade-?offs)\b/i, phase: 'deciding', weight: 8 },
  { pattern: /\b(better|prefer|choose|pick|select|decision)\b/i, phase: 'deciding', weight: 6 },

  // Building
  { pattern: /\b(create|build|make|implement|develop|write|code|generate)\b/i, phase: 'building', weight: 8 },
  { pattern: /\b(add|install|setup|configure|scaffold)\b/i, phase: 'building', weight: 7 },

  // Debugging
  { pattern: /\b(fix|debug|error|bug|broken|crash|issue|problem|fails?)\b/i, phase: 'debugging', weight: 9 },
  { pattern: /\b(not working|undefined|null|exception|wrong)\b/i, phase: 'debugging', weight: 8 },

  // Reviewing
  { pattern: /\b(review|check|verify|test|validate|audit|inspect)\b/i, phase: 'reviewing', weight: 7 },
  { pattern: /\b(looks? good|approve|merge|accept)\b/i, phase: 'reviewing', weight: 6 },

  // Deploying
  { pattern: /\b(deploy|publish|release|ship|launch|production|live)\b/i, phase: 'deploying', weight: 9 },
  { pattern: /\b(push|upload|host|domain|ssl|server)\b/i, phase: 'deploying', weight: 6 },
];

// ─── Pronoun Resolution Patterns ──────────────────────────────────────────────

const PRONOUN_PATTERNS = [
  /\b(that|this|it|those|these)\b/i,
  /\b(the (?:same|previous|last|above|earlier))\b/i,
  /\b((?:fix|change|update|modify|edit)\s+(?:it|that|this))\b/i,
];

// ─── Core Engine ──────────────────────────────────────────────────────────────

export class ConversationIntelligenceEngine {
  private snapshot: ConversationSnapshot = {
    emotionalState: 'neutral',
    emotionalIntensity: 0,
    intentPhase: 'exploring',
    activeTopics: [],
    recentReferences: [],
    conversationTurn: 0,
    avgResponseTime: 0,
    frustrationLevel: 0,
    urgencyLevel: 0,
  };

  private messageHistory: Array<{ role: 'user' | 'agent'; text: string; timestamp: number }> = [];

  /**
   * Analyze a user message and update the conversation snapshot.
   */
  analyzeMessage(message: string): ConversationSnapshot {
    this.snapshot.conversationTurn++;
    this.messageHistory.push({ role: 'user', text: message, timestamp: Date.now() });

    // Detect emotional state
    this.detectEmotion(message);

    // Detect intent phase
    this.detectIntentPhase(message);

    // Extract references
    this.extractReferences(message);

    // Update topics
    this.updateTopics(message);

    // Trim history
    if (this.messageHistory.length > 50) {
      this.messageHistory = this.messageHistory.slice(-30);
    }

    return { ...this.snapshot };
  }

  /**
   * Record the agent's response for tracking.
   */
  recordAgentResponse(response: string): void {
    this.messageHistory.push({ role: 'agent', text: response.substring(0, 500), timestamp: Date.now() });
  }

  /**
   * Resolve pronouns/references in a message.
   * "Fix that thing" → "Fix the file X that had error Y"
   */
  resolveReferences(message: string): { resolved: string; resolutions: string[] } {
    let resolved = message;
    const resolutions: string[] = [];

    for (const pattern of PRONOUN_PATTERNS) {
      if (pattern.test(message)) {
        // Find the most likely referent from recent references
        const sorted = [...this.snapshot.recentReferences]
          .sort((a, b) => b.lastReferencedAt - a.lastReferencedAt);

        if (sorted.length > 0) {
          const referent = sorted[0];
          resolutions.push(`"${pattern.source.substring(0, 20)}" likely refers to ${referent.type}: "${referent.value}"`);
        }
      }
    }

    return { resolved, resolutions };
  }

  /**
   * Generate proactive suggestions based on conversation state.
   */
  generateSuggestions(toolsUsed: string[], filesCreated: string[]): ProactiveSuggestion[] {
    const suggestions: ProactiveSuggestion[] = [];

    // After creating files, suggest testing
    if (filesCreated.length > 0 && !toolsUsed.includes('workspace_verify_code')) {
      suggestions.push({
        text: 'Run code verification to check for errors',
        confidence: 0.8,
        category: 'next_step',
      });
    }

    // After debugging, suggest testing
    const usedEditTool = toolsUsed.some(tool => [
      'workspace_str_replace',
      'workspace_apply_patch',
      'workspace_edit_file',
      'workspace_edit_many_files',
    ].includes(tool));
    if (this.snapshot.intentPhase === 'debugging' && usedEditTool) {
      suggestions.push({
        text: 'Run tests to verify the fix works correctly',
        confidence: 0.85,
        category: 'next_step',
      });
    }

    // After building, suggest git commit
    if (this.snapshot.intentPhase === 'building' && filesCreated.length >= 3 && !toolsUsed.includes('git_operations')) {
      suggestions.push({
        text: 'Commit changes to git',
        confidence: 0.6,
        category: 'next_step',
      });
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
  }

  /**
   * Build conversation context for the system prompt.
   */
  buildConversationContext(): string {
    const parts: string[] = [];

    // Emotional awareness
    if (this.snapshot.emotionalState !== 'neutral') {
      const emotionStr = this.getEmotionGuidance();
      if (emotionStr) parts.push(emotionStr);
    }

    // Intent phase
    parts.push(`User intent phase: ${this.snapshot.intentPhase}`);

    // Active topics
    if (this.snapshot.activeTopics.length > 0) {
      parts.push(`Active topics: ${this.snapshot.activeTopics.slice(0, 5).join(', ')}`);
    }

    // Reference resolution hints
    const recentRefs = this.snapshot.recentReferences
      .filter(r => Date.now() - r.lastReferencedAt < 300_000) // Last 5 min
      .sort((a, b) => b.referenceCount - a.referenceCount)
      .slice(0, 5);
    if (recentRefs.length > 0) {
      parts.push(`Recent context: ${recentRefs.map(r => `${r.type}:${r.value}`).join(', ')}`);
    }

    return parts.filter(Boolean).join('\n');
  }

  /**
   * Get the current conversation snapshot.
   */
  getSnapshot(): ConversationSnapshot {
    return { ...this.snapshot };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private detectEmotion(message: string): void {
    let bestState: EmotionalState = 'neutral';
    let bestIntensity = 0;

    for (const { pattern, state, intensity } of EMOTION_PATTERNS) {
      if (pattern.test(message)) {
        if (intensity > bestIntensity) {
          bestState = state;
          bestIntensity = intensity;
        }
      }
    }

    // Apply momentum — emotions don't change instantly
    if (bestState === this.snapshot.emotionalState) {
      this.snapshot.emotionalIntensity = Math.min(1, this.snapshot.emotionalIntensity + 0.1);
    } else if (bestIntensity > this.snapshot.emotionalIntensity * 0.7) {
      this.snapshot.emotionalState = bestState;
      this.snapshot.emotionalIntensity = bestIntensity;
    } else {
      // Decay current emotion
      this.snapshot.emotionalIntensity *= 0.8;
      if (this.snapshot.emotionalIntensity < 0.2) {
        this.snapshot.emotionalState = 'neutral';
        this.snapshot.emotionalIntensity = 0;
      }
    }

    // Update frustration and urgency levels
    if (bestState === 'frustrated') {
      this.snapshot.frustrationLevel = Math.min(1, this.snapshot.frustrationLevel + 0.2);
    } else {
      this.snapshot.frustrationLevel *= 0.9;
    }

    if (bestState === 'urgent') {
      this.snapshot.urgencyLevel = Math.min(1, this.snapshot.urgencyLevel + 0.3);
    } else {
      this.snapshot.urgencyLevel *= 0.85;
    }
  }

  private detectIntentPhase(message: string): void {
    const scores: Map<IntentPhase, number> = new Map();

    for (const { pattern, phase, weight } of INTENT_PATTERNS) {
      if (pattern.test(message)) {
        scores.set(phase, (scores.get(phase) || 0) + weight);
      }
    }

    if (scores.size > 0) {
      let bestPhase: IntentPhase = this.snapshot.intentPhase;
      let bestScore = 0;
      for (const [phase, score] of scores) {
        if (score > bestScore) {
          bestPhase = phase;
          bestScore = score;
        }
      }
      this.snapshot.intentPhase = bestPhase;
    }
  }

  private extractReferences(message: string): void {
    // File references
    const fileRefs = message.match(/\b[\w\-\/\\]+\.\w{1,6}\b/g) || [];
    for (const ref of fileRefs) {
      this.addReference('file', ref);
    }

    // Error references
    const errorRefs = message.match(/\b(?:error|exception|warning|TypeError|ReferenceError|SyntaxError)\b[^.]{0,80}/gi) || [];
    for (const ref of errorRefs) {
      this.addReference('error', ref.substring(0, 80));
    }

    // Feature/concept references
    const conceptRefs = message.match(/\b(?:the |a )?(?:login|dashboard|sidebar|navbar|header|footer|modal|form|button|table|chart|api|database|auth|route|page|component)\b/gi) || [];
    for (const ref of conceptRefs) {
      this.addReference('concept', ref.trim());
    }
  }

  private addReference(type: ContextReference['type'], value: string): void {
    const existing = this.snapshot.recentReferences.find(r => r.type === type && r.value === value);
    if (existing) {
      existing.lastReferencedAt = Date.now();
      existing.referenceCount++;
    } else {
      this.snapshot.recentReferences.push({
        type,
        value,
        mentionedAt: Date.now(),
        lastReferencedAt: Date.now(),
        referenceCount: 1,
      });
    }

    // Limit references
    if (this.snapshot.recentReferences.length > 30) {
      this.snapshot.recentReferences.sort((a, b) => b.lastReferencedAt - a.lastReferencedAt);
      this.snapshot.recentReferences = this.snapshot.recentReferences.slice(0, 20);
    }
  }

  private updateTopics(message: string): void {
    // Extract key nouns/topics (simple heuristic)
    const words = message.split(/\s+/)
      .filter(w => w.length > 4)
      .filter(w => !/^(about|their|which|would|could|should|there|where|these|those|being|after|before|while|since|until|above|below)$/i.test(w))
      .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(w => w.length > 3);

    // Merge with existing topics (recent first)
    const newTopics = [...new Set(words)].slice(0, 5);
    this.snapshot.activeTopics = [...new Set([...newTopics, ...this.snapshot.activeTopics])].slice(0, 10);
  }

  private getEmotionGuidance(): string {
    switch (this.snapshot.emotionalState) {
      case 'frustrated':
        return '⚠️ User is frustrated — be precise, acknowledge the issue, fix it immediately. No fluff.';
      case 'urgent':
        return '🔴 URGENT — User needs this NOW. Prioritize speed. Skip non-essential steps.';
      case 'confused':
        return '❓ User is confused — explain clearly, use examples, break down complex concepts.';
      case 'appreciative':
        return '💪 User appreciates your work — deliver your absolute best. Go above and beyond.';
      case 'positive':
        return ''; // No special guidance needed for positive
      default:
        return '';
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const conversationIntelligence = new ConversationIntelligenceEngine();
