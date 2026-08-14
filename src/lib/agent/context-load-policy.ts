export type ContextLoadPolicy = {
  mode: 'minimal' | 'standalone' | 'continuation' | 'deep';
  loadWorkspace: boolean;
  loadIntelligence: boolean;
  loadRelevantMemory: boolean;
  loadLifetimeMemory: boolean;
  loadAdaptiveRules: boolean;
  loadCognitiveContext: boolean;
  memoryTokenBudget: number;
  /** Hard budget for the complete per-request dynamic context channel. */
  dynamicContextTokenBudget: number;
};

/**
 * Cheap, deterministic context gating. This does not decide what the task
 * means; it only decides how much old state is useful for the current turn.
 */
export function getContextLoadPolicy(message: string, wantsContinuity: boolean): ContextLoadPolicy {
  const text = String(message || '').trim();
  const wordCount = text ? text.split(/\s+/).length : 0;
  const minimal = wordCount <= 12 && /^(?:hi|hey|hello|yo|thanks?|thank you|ok(?:ay)?|cool|great|got it|bye|good (?:morning|afternoon|evening))[!.?\s]*$/i.test(text);
  const deep = !minimal && (
    text.length > 1800
    || /\b(?:deep work|deep research|comprehensive|exhaustive|entire (?:project|codebase|system)|all files|do not stop|don't stop|multi[- ]hour|overnight)\b/i.test(text)
  );

  if (minimal) {
    return {
      mode: 'minimal',
      loadWorkspace: false,
      loadIntelligence: false,
      loadRelevantMemory: false,
      loadLifetimeMemory: false,
      loadAdaptiveRules: false,
      loadCognitiveContext: false,
      memoryTokenBudget: 250,
      dynamicContextTokenBudget: 450,
    };
  }

  if (wantsContinuity) {
    return {
      mode: 'continuation',
      loadWorkspace: true,
      loadIntelligence: true,
      loadRelevantMemory: true,
      loadLifetimeMemory: true,
      loadAdaptiveRules: true,
      loadCognitiveContext: true,
      memoryTokenBudget: 1400,
      dynamicContextTokenBudget: 2800,
    };
  }

  if (deep) {
    return {
      mode: 'deep',
      loadWorkspace: true,
      loadIntelligence: true,
      loadRelevantMemory: true,
      loadLifetimeMemory: true,
      loadAdaptiveRules: true,
      loadCognitiveContext: true,
      memoryTokenBudget: 1800,
      dynamicContextTokenBudget: 3500,
    };
  }

  return {
    mode: 'standalone',
    loadWorkspace: true,
    loadIntelligence: true,
    loadRelevantMemory: true,
    loadLifetimeMemory: false,
    loadAdaptiveRules: false,
    loadCognitiveContext: true,
    memoryTokenBudget: 900,
    dynamicContextTokenBudget: 1800,
  };
}
