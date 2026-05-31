/**
 * ═══════════════════════════════════════════════════════════════
 * REASONING ENGINE — Barrel Export
 * ═══════════════════════════════════════════════════════════════
 * All advanced reasoning modules exported from a single entry point.
 */

export { cognitiveEngine, type CognitiveState, type ProblemClass } from './cognitive-engine';
export { deepSelfCorrection, type SelfCorrectionResult } from './self-correction';
export { verificationPipeline, type VerificationResult } from './verification-pipeline';
export { promptLayers } from './prompt-layers';
export { toolIntelligence } from './tool-intelligence';
export { conversationIntelligence } from './conversation-intelligence';
export { contextIntelligence } from './context-intelligence';
export { precisionOutput } from './output-engine';
