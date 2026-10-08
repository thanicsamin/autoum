export type VoicePreferences = { speakReplies: boolean; voice: string; mode: 'push' | 'conversation'; fallbackEnabled: boolean; fallbackVoice: string };
export const nativeVoices = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];
export const defaultVoicePreferences: VoicePreferences = { speakReplies: true, voice: 'marin', mode: 'push', fallbackEnabled: true, fallbackVoice: 'af_heart' };
export function voicePreferences(value: any): VoicePreferences {
  return { speakReplies: value?.speakReplies !== false, voice: nativeVoices.includes(value?.voice) ? value.voice : 'marin', mode: value?.mode === 'conversation' ? 'conversation' : 'push', fallbackEnabled: value?.fallbackEnabled !== false, fallbackVoice: ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_puck'].includes(value?.fallbackVoice) ? value.fallbackVoice : 'af_heart' };
}
