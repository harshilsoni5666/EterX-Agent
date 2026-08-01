export type LiveVoiceOption = {
  value: string;
  label: string;
  tag?: string;
  description?: string;
};

/**
 * Voices accepted by the current realtime media transport. Keeping this
 * catalog outside the Settings component lets the server return the same
 * compatible set for every reasoning provider without duplicating IDs.
 */
export const GEMINI_LIVE_VOICE_OPTIONS: LiveVoiceOption[] = [
  { value: 'auto', label: 'Auto (Media Model Default)', tag: 'AUTO', description: 'Uses the active Live media model’s recommended default voice' },
  { value: 'Kore', label: 'Kore', description: 'Firm, confident female voice' },
  { value: 'Aoede', label: 'Aoede', description: 'Breezy, natural female voice' },
  { value: 'Charon', label: 'Charon', description: 'Informative, clear male voice' },
  { value: 'Puck', label: 'Puck', description: 'Upbeat, energetic male voice' },
  { value: 'Fenrir', label: 'Fenrir', description: 'Excitable, dynamic male voice' },
  { value: 'Zephyr', label: 'Zephyr', description: 'Bright, cheerful female voice' },
  { value: 'Enceladus', label: 'Enceladus', description: 'Breathy, calm male voice' },
  { value: 'Vindemiatrix', label: 'Vindemiatrix', description: 'Gentle, dramatic female voice' },
  { value: 'Leda', label: 'Leda', description: 'Youthful female voice' },
  { value: 'Orus', label: 'Orus', description: 'Firm male voice' },
  { value: 'Callirrhoe', label: 'Callirrhoe', description: 'Easy-going female voice' },
  { value: 'Autonoe', label: 'Autonoe', description: 'Bright female voice' },
  { value: 'Iapetus', label: 'Iapetus', description: 'Clear male voice' },
  { value: 'Umbriel', label: 'Umbriel', description: 'Easy-going male voice' },
  { value: 'Algenib', label: 'Algenib', description: 'Gravelly male voice' },
  { value: 'Despina', label: 'Despina', description: 'Smooth female voice' },
  { value: 'Erinome', label: 'Erinome', description: 'Clear female voice' },
  { value: 'Laomedeia', label: 'Laomedeia', description: 'Upbeat female voice' },
  { value: 'Achernar', label: 'Achernar', description: 'Soft female voice' },
  { value: 'Algieba', label: 'Algieba', description: 'Smooth male voice' },
  { value: 'Schedar', label: 'Schedar', description: 'Even male voice' },
  { value: 'Gacrux', label: 'Gacrux', description: 'Mature female voice' },
  { value: 'Pulcherrima', label: 'Pulcherrima', description: 'Forward female voice' },
  { value: 'Achird', label: 'Achird', description: 'Friendly male voice' },
  { value: 'Zubenelgenubi', label: 'Zubenelgenubi', description: 'Casual male voice' },
  { value: 'Sadachbia', label: 'Sadachbia', description: 'Lively male voice' },
  { value: 'Sadaltager', label: 'Sadaltager', description: 'Knowledgeable male voice' },
  { value: 'Sulafat', label: 'Sulafat', description: 'Warm female voice' },
  { value: 'Alnilam', label: 'Alnilam', description: 'Firm male voice' },
  { value: 'Rasalgethi', label: 'Rasalgethi', description: 'Informative male voice' },
];
