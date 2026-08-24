export type RequestTokenBudget = {
  estimatedInputTokens: number;
  systemTokens: number;
  staticPromptTokens: number;
  dynamicPromptTokens: number;
  toolDefinitionTokens: number;
  fullToolSchemaTokens: number;
  staticBundleTokens: number;
  messageTokens: number;
  conversationTokens: number;
  toolResultTokens: number;
  systemMessageTokens: number;
  messageCount: number;
  toolCount: number;
};

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function providerToolResultChars(messages: any[]): number {
  let chars = 0;
  for (const message of messages || []) {
    if (message?.role === 'tool') {
      chars += serializedLength(message.content);
      continue;
    }
    const blocks = Array.isArray(message?.content)
      ? message.content
      : Array.isArray(message?.parts)
        ? message.parts
        : [];
    for (const block of blocks) {
      if (block?.type === 'tool_result') chars += serializedLength(block.content);
      if (block?.functionResponse) chars += serializedLength(block.functionResponse.response);
    }
  }
  return chars;
}

/** Low-cost, provider-neutral request accounting for runtime diagnostics. */
export function estimateRequestTokenBudget(input: {
  system?: unknown;
  staticPrompt?: unknown;
  dynamicPrompt?: unknown;
  /** Add the static prompt because the provider is serving it from a cache. */
  includeStaticPromptInEstimate?: boolean;
  tools?: unknown[];
  messages?: any[];
}): RequestTokenBudget {
  const messages = input.messages || [];
  const tools = input.tools || [];
  const systemChars = serializedLength(input.system);
  const staticPromptChars = serializedLength(input.staticPrompt);
  const dynamicPromptChars = serializedLength(input.dynamicPrompt);
  const toolChars = serializedLength(tools);
  const messageChars = serializedLength(messages);
  const systemMessageChars = serializedLength(messages.filter(message => message?.role === 'system'));
  const conversationChars = serializedLength(messages.filter(message => message?.role !== 'system'));
  const toolResultChars = providerToolResultChars(messages);
  const staticPromptTokens = estimateTokens(staticPromptChars);
  const toolDefinitionTokens = estimateTokens(toolChars);
  const cachedStaticChars = input.includeStaticPromptInEstimate ? staticPromptChars : 0;
  return {
    estimatedInputTokens: estimateTokens(systemChars + cachedStaticChars + toolChars + messageChars),
    systemTokens: estimateTokens(systemChars),
    staticPromptTokens,
    dynamicPromptTokens: estimateTokens(dynamicPromptChars),
    toolDefinitionTokens,
    fullToolSchemaTokens: toolDefinitionTokens,
    staticBundleTokens: staticPromptTokens + toolDefinitionTokens,
    messageTokens: estimateTokens(messageChars),
    conversationTokens: estimateTokens(conversationChars),
    toolResultTokens: estimateTokens(toolResultChars),
    systemMessageTokens: estimateTokens(systemMessageChars),
    messageCount: messages.length,
    toolCount: tools.length,
  };
}
