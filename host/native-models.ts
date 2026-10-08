// Realtime models use OpenAI's native audio connection, never Pi text inference.
export function nativeVoiceModel(provider: string, model: string) { return provider === 'openai' && /^gpt-realtime(?:-mini)?(?:-\d+(?:\.\d+)*)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model); }
