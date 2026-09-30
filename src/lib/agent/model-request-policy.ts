// Model work has no application deadline. GoogleGenAI treats zero as disabled;
// OpenAI/Anthropic must use model-clients, since their SDKs otherwise treat zero
// as an immediate timer. Caller AbortSignals still implement Stop.
export const MODEL_REQUEST_TIMEOUT_MS = 0;
