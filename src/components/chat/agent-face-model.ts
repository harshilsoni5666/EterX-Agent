export const AGENT_FACE_STATES = [
  'idle',
  'thinking',
  'working',
  'happy',
  'success',
  'error',
  'surprised',
  'listening',
  'speaking',
  'excited',
  'sleeping',
  'curious',
  'loading',
  'frustrated',
  'calm',
  'celebrating',
  'skeptical',
  'sad',
  'proud',
  'waiting',
] as const;

export type AgentFaceState = typeof AGENT_FACE_STATES[number];

export type LiveIndicatorMode =
  | AgentFaceState
  | 'acting'
  | 'searching'
  | 'writing'
  | 'running'
  | 'coding'
  | 'memory';

export type AgentFaceReaction =
  | 'none'
  | 'curious'
  | 'laugh'
  | 'angry'
  | 'settling'
  | 'wink-left'
  | 'wink-right';

type AgentFaceMood =
  | AgentFaceState
  | 'acting'
  | 'searching'
  | 'writing'
  | 'running'
  | 'coding'
  | 'memory'
  | 'laugh'
  | 'angry'
  | 'settling';

type FaceMicroProfile = {
  gx: number;
  gy: number;
  blink: number;
  smile: number;
  cheek: number;
  shine: number;
};

export type AgentFaceExpression = {
  mood: AgentFaceMood;
  active: boolean;
  isRage: boolean;
  isCurious: boolean;
  isLaughing: boolean;
  isSettling: boolean;
  isIntense: boolean;
  isSleeping: boolean;
  isSpeaking: boolean;
  isSurprised: boolean;
  isSkeptical: boolean;
  isHappy: boolean;
  isWorking: boolean;
  isCalm: boolean;
  pace: number;
  profile: FaceMicroProfile;
  gazeX: number[];
  gazeY: number[];
  blinkDuration: number;
  blinkScale: number[];
  blinkTimes: number[];
  blinkOpacity: number[];
  smileOpacity: number | number[];
  eyeHeight: number;
  eyeWidth: number;
  eyeTop: number;
  eyeLeft: [number, number];
  eyeFill: string;
  mouthTop: number;
  mouthWidth: number;
  mouthLeft: number;
  mouthStroke: number;
  smilePath: string;
  frownPath: string;
  faceGradient: string;
  glowColor: string;
  cheekLeftOpacity: number | number[];
  cheekRightOpacity: number | number[];
};

const FACE_MICRO_PROFILES: FaceMicroProfile[] = [
  { gx: -0.34, gy: -0.08, blink: 3.2, smile: 10.4, cheek: 0.16, shine: 0.0 },
  { gx: 0.28, gy: -0.18, blink: 4.1, smile: 11.2, cheek: 0.22, shine: 0.2 },
  { gx: -0.12, gy: 0.10, blink: 3.7, smile: 9.8, cheek: 0.14, shine: 0.4 },
  { gx: 0.14, gy: -0.05, blink: 5.0, smile: 10.8, cheek: 0.18, shine: 0.6 },
  { gx: -0.42, gy: 0.02, blink: 4.6, smile: 10.0, cheek: 0.20, shine: 0.8 },
  { gx: 0.40, gy: -0.12, blink: 3.9, smile: 11.4, cheek: 0.15, shine: 1.0 },
  { gx: -0.20, gy: -0.22, blink: 4.8, smile: 10.6, cheek: 0.24, shine: 1.2 },
  { gx: 0.08, gy: 0.08, blink: 3.4, smile: 9.6, cheek: 0.17, shine: 1.4 },
  { gx: -0.04, gy: -0.16, blink: 5.2, smile: 10.9, cheek: 0.19, shine: 1.6 },
  { gx: 0.32, gy: 0.04, blink: 4.3, smile: 10.2, cheek: 0.13, shine: 1.8 },
  { gx: -0.28, gy: -0.04, blink: 3.6, smile: 11.0, cheek: 0.21, shine: 2.0 },
  { gx: 0.18, gy: -0.20, blink: 4.9, smile: 10.1, cheek: 0.16, shine: 2.2 },
];

const actionMatchers: Array<{ mood: AgentFaceMood; pattern: RegExp }> = [
  { mood: 'error', pattern: /error|failed|blocked|denied|invalid|exception|broken|fix/i },
  { mood: 'memory', pattern: /memory|recall|context|profile|history/i },
  { mood: 'searching', pattern: /search|scan|research|find|read|inspect|locat|audit|analyz/i },
  { mood: 'writing', pattern: /edit|write|create|generat|file|patch|apply|render|design/i },
  { mood: 'coding', pattern: /code|tsx|jsx|typescript|component|css|build|lint|compile/i },
  { mood: 'running', pattern: /command|terminal|install|run|execute|npm|powershell|server/i },
  { mood: 'success', pattern: /done|complete|passed|success|verified|created|fixed/i },
];

export function isAgentFaceState(value: string): value is AgentFaceState {
  return (AGENT_FACE_STATES as readonly string[]).includes(value);
}

export function hashAgentFaceSignal(value: string, salt = 0): number {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function inferFaceMood(mode: LiveIndicatorMode, reaction: AgentFaceReaction, actionKey: string): AgentFaceMood {
  if (reaction === 'angry') return 'settling';
  if (reaction === 'settling') return 'settling';
  if (reaction === 'laugh') return 'laugh';
  if (reaction === 'wink-left' || reaction === 'wink-right') return 'happy';
  if (reaction === 'curious') return 'curious';
  if (mode === 'error') return 'error';
  if (isAgentFaceState(mode)) return mode;
  if (mode !== 'acting') return mode;

  const text = actionKey.toLowerCase();
  for (const matcher of actionMatchers) {
    if (matcher.pattern.test(text)) return matcher.mood;
  }

  return 'working';
}

const AGENT_FACE_GRADIENT = 'radial-gradient(circle at 35% 22%, #F3E3FF 0%, #A35CFF 24%, #5B9DFF 58%, #123D75 100%)';

export function resolveAgentFaceExpression({
  mode,
  reaction,
  seed,
  actionKey,
}: {
  mode: LiveIndicatorMode;
  reaction: AgentFaceReaction;
  seed: number;
  actionKey: string;
}): AgentFaceExpression {
  const mood = inferFaceMood(mode, reaction, actionKey);
  const active = mode !== 'idle' || reaction !== 'none';
  const isRage = false;
  const isSleeping = mood === 'sleeping';
  const isSpeaking = mood === 'speaking';
  const isSurprised = mood === 'surprised';
  const isSkeptical = mood === 'skeptical';
  const isHappy = ['happy', 'success', 'proud', 'celebrating', 'excited'].includes(mood);
  const isWorking = ['working', 'acting', 'running', 'writing', 'coding', 'memory', 'loading'].includes(mood);
  const isCalm = mood === 'calm' || mood === 'waiting' || mood === 'settling';
  const isCurious = mood === 'curious' || isSurprised || isSkeptical || mood === 'listening';
  const isLaughing = mood === 'laugh' || mood === 'celebrating';
  const isSettling = mood === 'settling' || isCalm;
  const isIntense = mood === 'error' || mood === 'sad';
  const profile = FACE_MICRO_PROFILES[Math.abs(seed) % FACE_MICRO_PROFILES.length];
  const pace = isSleeping ? 5.4 : isLaughing || mood === 'excited' ? 2.6 : isSettling ? 4.05 : active ? 3.55 + (Math.abs(seed) % 3) * 0.22 : 5.9;

  const gazeStrength = mood === 'searching' ? 0.1 : mood === 'writing' || mood === 'coding' ? 0.07 : 0.05;
  const moodGazeX = isSleeping ? 0 : isIntense ? profile.gx * 0.025 : isLaughing ? -0.012 : isSkeptical ? -0.026 : isCurious ? 0.018 : isSettling ? -0.014 : isWorking ? profile.gx * gazeStrength : profile.gx * 0.04;
  const moodGazeY = isSleeping ? 0 : isIntense ? 0.05 : isLaughing ? -0.035 : isSurprised ? -0.06 : isCurious ? -0.14 : isSettling ? 0.045 : isWorking ? profile.gy * 0.38 : profile.gy * 0.28;

  const blinkDuration = isSleeping ? 4.8 : isLaughing ? 2.35 : isSettling ? 3.15 : mood === 'error' || mood === 'sad' ? 2.9 : active ? profile.blink + 0.35 : profile.blink + 2.1;
  const blinkScale = isSleeping
      ? [0.12, 0.14, 0.1, 0.13]
    : isLaughing
      ? [0.72, 0.52, 0.68, 0.54, 0.72]
    : isSettling
      ? [0.84, 0.9, 0.28, 0.86, 0.78]
    : mood === 'error' || mood === 'sad'
      ? [0.72, 0.8, 0.72, 0.72]
      : isSurprised
        ? [1.12, 1.1, 1.08, 1.12]
      : active
        ? [1, 1, 0.22, 1, 1, 0.48, 1, 1]
        : [1, 1, 1, 0.28, 1, 1];
  const blinkTimes = isSleeping
      ? [0, 0.36, 0.72, 1]
    : isLaughing
      ? [0, 0.24, 0.48, 0.72, 1]
    : isSettling
      ? [0, 0.48, 0.55, 0.72, 1]
    : mood === 'error' || mood === 'sad'
      ? [0, 0.5, 0.75, 1]
      : isSurprised
        ? [0, 0.35, 0.7, 1]
      : active
        ? [0, 0.54, 0.575, 0.615, 0.8, 0.83, 0.87, 1]
        : [0, 0.72, 0.78, 0.815, 0.86, 1];
  const blinkOpacity = isSleeping
      ? [0.86, 0.82, 0.88, 0.84]
    : isLaughing
      ? [0.96, 1, 0.95, 1, 0.96]
    : isSettling
      ? [0.9, 0.98, 0.78, 0.92, 0.88]
    : mood === 'error' || mood === 'sad'
      ? [0.78, 0.9, 0.78, 0.78]
      : active
        ? [1, 1, 0.72, 1, 1, 0.82, 1, 1]
        : [1, 1, 1, 0.72, 1, 1];

  const gazeX = isSleeping
      ? [0, 0.012, -0.01, 0]
    : isLaughing
      ? [-0.05, 0.04, -0.02, -0.05]
    : isSettling
      ? [-0.03, 0.015, -0.02, -0.03]
    : mood === 'error' || mood === 'sad'
      ? [0, 0.035, -0.03, 0]
      : isSpeaking
        ? [moodGazeX, moodGazeX + 0.03, moodGazeX - 0.02, moodGazeX]
      : [moodGazeX, moodGazeX * -0.15, moodGazeX * 0.12, moodGazeX];
  const gazeY = isSleeping
      ? [0.18, 0.16, 0.2, 0.18]
    : isLaughing
      ? [-0.04, -0.18, -0.02, -0.04]
    : isSettling
      ? [0.08, 0.02, 0.1, 0.08]
    : mood === 'error' || mood === 'sad'
      ? [0.12, 0.24, 0.06, 0.12]
      : isSpeaking
        ? [moodGazeY, moodGazeY - 0.12, moodGazeY + 0.08, moodGazeY]
      : [moodGazeY, moodGazeY - 0.38, moodGazeY + 0.14, moodGazeY];

  const smileOpacity = isIntense
    ? 0
    : isSleeping
      ? 0.42
    : isSpeaking
      ? [0.78, 0.92, 0.82, 0.88]
    : isWorking
      ? [0.82, 0.92, 0.84]
      : active
        ? [0.82, 0.9, 0.82]
        : 0.78;

  const eyeHeight = isSleeping ? 1.5 : isSurprised ? 8.3 : isLaughing ? 6.55 : isSettling ? 6.7 : isCurious ? 7.15 : isWorking ? 6.8 : 6.65;
  const eyeWidth = isSurprised ? 4.05 : isCurious ? 3.95 : isLaughing ? 3.9 : 3.75;
  const eyeTop = isSleeping ? 2.4 : isSurprised ? -1.1 : isLaughing ? -0.05 : isSettling ? -0.04 : isCurious ? -0.48 : -0.12;
  const eyeLeft: [number, number] = isCurious ? [9.45, 17.95] : isLaughing ? [9.5, 17.9] : [9.55, 17.85];
  const eyeFill = isSettling
      ? 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(232,238,255,0.88))'
    : 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(227,243,255,0.9))';

  const mouthTop = isIntense ? 20.65 : isSurprised ? 20.2 : isCurious ? 20.35 : 20.45;
  const mouthWidth = isSurprised ? 10.2 : isCurious ? 14.8 : isHappy ? 15.0 : 14.2;
  const mouthLeft = 17 - mouthWidth / 2;
  const mouthStroke = isSurprised ? 1.72 : isCurious ? 1.62 : 1.56;
  const smilePath = isSurprised
    ? 'M5.6 3.8 C5.6 1.8 10.4 1.8 10.4 3.8 C10.4 5.7 5.6 5.7 5.6 3.8'
    : isSleeping
      ? 'M4.4 2.9 C6.05 4.3 9.95 4.3 11.6 2.9'
    : isSpeaking
      ? 'M3.55 2.55 C5.05 5.15 10.95 5.15 12.45 2.55'
    : isHappy || isLaughing
      ? 'M3.25 2.1 C5.05 5.55 10.95 5.55 12.75 2.1'
    : isCurious
    ? 'M3.6 2.3 C5.3 5.2 10.9 5.2 12.6 2.3'
    : isSettling
      ? 'M3.7 2.65 C5.35 4.7 10.65 4.7 12.3 2.65'
    : isWorking
      ? 'M3.8 2.38 C5.45 4.9 10.55 4.9 12.2 2.38'
      : 'M3.7 2.35 C5.35 5.05 10.65 5.05 12.3 2.35';
  const frownPath = 'M3.8 4.9 C5.45 3.15 10.55 3.15 12.2 4.9';

  const cheekLeftOpacity = mood === 'error' || mood === 'sad'
      ? [0.12, 0.22, 0.12]
      : isHappy || isLaughing
        ? [0.2, 0.32, 0.22]
      : [profile.cheek, profile.cheek + 0.08, profile.cheek];
  const cheekRightOpacity = mood === 'error' || mood === 'sad'
      ? [0.1, 0.2, 0.1]
      : isHappy || isLaughing
        ? [0.18, 0.3, 0.2]
      : [profile.cheek * 0.8, profile.cheek + 0.05, profile.cheek * 0.8];

  return {
    mood,
    active,
    isRage,
    isCurious,
    isLaughing,
    isSettling,
    isIntense,
    isSleeping,
    isSpeaking,
    isSurprised,
    isSkeptical,
    isHappy,
    isWorking,
    isCalm,
    pace,
    profile,
    gazeX,
    gazeY,
    blinkDuration,
    blinkScale,
    blinkTimes,
    blinkOpacity,
    smileOpacity,
    eyeHeight,
    eyeWidth,
    eyeTop,
    eyeLeft,
    eyeFill,
    mouthTop,
    mouthWidth,
    mouthLeft,
    mouthStroke,
    smilePath,
    frownPath,
    faceGradient: AGENT_FACE_GRADIENT,
    glowColor: 'rgba(91,157,255,0.10)',
    cheekLeftOpacity,
    cheekRightOpacity,
  };
}
