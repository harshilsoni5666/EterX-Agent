export type RequestTokenBudget = {
  estimatedInputTokens: number;
  systemTokens: number;
  toolDefinitionTokens: number;
  messageTokens: number;
  toolResultTokens: number;
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
  tools?: unknown[];
  messages?: any[];
}): RequestTokenBudget {
  const messages = input.messages || [];
  const tools = input.tools || [];
  const systemChars = serializedLength(input.system);
  const toolChars = serializedLength(tools);
  const messageChars = serializedLength(messages);
  const toolResultChars = providerToolResultChars(messages);
  return {
    estimatedInputTokens: estimateTokens(systemChars + toolChars + messageChars),
    systemTokens: estimateTokens(systemChars),
    toolDefinitionTokens: estimateTokens(toolChars),
    messageTokens: estimateTokens(messageChars),
    toolResultTokens: estimateTokens(toolResultChars),
    messageCount: messages.length,
    toolCount: tools.length,
  };
}
