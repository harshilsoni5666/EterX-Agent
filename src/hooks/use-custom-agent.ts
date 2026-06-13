/**
 * useCustomAgent — Hook for running custom-built agents from the chat UI
 * 
 * This hook manages the lifecycle of running a custom agent:
 * 1. Fetches the agent's readiness status
 * 2. Streams events from /api/agents/run
 * 3. Converts events into trace logs compatible with the main chat feed
 * 4. Manages agent state (loading, running, done, error)
 */
import { useState, useCallback, useRef } from 'react';

export interface CustomAgentState {
  agentId: string | null;
  agentName: string;
  isRunning: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface CustomAgentTraceLog {
  id: string;
  type: string;
  text: string;
  secondary?: string;
  timestamp: number;
  agentName?: string;
  [key: string]: unknown;
}

const RUNTIME_SECRET_PATTERNS: RegExp[] = [
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bsk-(?:proj-|ant-|live-|test-)?[0-9A-Za-z_-]{16,}\b/g,
  /\b(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|secret|password|passwd)\s*[:=]\s*(?:Bearer\s+)?['"]?[^'"\r\n&]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

const redactRuntimeText = (value: unknown, maxLength = 2000) => {
  const raw = String(value ?? '');
  const clipped = raw.length > maxLength ? `${raw.slice(0, maxLength)}\n...[truncated]` : raw;
  return RUNTIME_SECRET_PATTERNS.reduce((text, pattern) => (
    text.replace(pattern, (match) => {
      const separator = match.match(/^(.+?\s*[:=]\s*)(?:Bearer\s+)?/i);
      if (separator) return `${separator[1]}[redacted]`;
      if (/^Bearer\s+/i.test(match)) return 'Bearer [redacted]';
      return '[redacted]';
    })
  ), clipped);
};

const stringifyTraceValue = (value: unknown, maxLength = 200) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return redactRuntimeText(text, maxLength);
};

export function useCustomAgent() {
  const [state, setState] = useState<CustomAgentState>({
    agentId: null,
    agentName: '',
    isRunning: false,
    isLoading: false,
    error: null,
  });
  const [traceLogs, setTraceLogs] = useState<CustomAgentTraceLog[]>([]);
  const [responseText, setResponseText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const runSeqRef = useRef(0);

  /** Check if an agent is ready to run */
  const checkAgent = useCallback(async (agentId: string): Promise<{
    ready: boolean;
    name?: string;
    error?: string;
  }> => {
    try {
      const res = await fetch(`/api/agents/run?agentId=${encodeURIComponent(agentId)}`);
      const data = await res.json();
      if (!res.ok) {
        return { ready: false, error: data?.error || `HTTP ${res.status}` };
      }
      return data;
    } catch (err: any) {
      return { ready: false, error: err.message };
    }
  }, []);

  /** Start running a custom agent with a message */
  const runAgent = useCallback(async (
    agentId: string,
    message: string,
    history: Array<{ role: 'user' | 'model'; content: string }> = []
  ) => {
    // Cancel any running agent
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const runSeq = ++runSeqRef.current;
    const isCurrentRun = () => abortRef.current === controller && runSeqRef.current === runSeq;

    setState(prev => ({
      ...prev,
      agentId,
      isRunning: true,
      isLoading: true,
      error: null,
    }));
    setResponseText('');
    setTraceLogs([]);

    const messages = [
      ...history,
      { role: 'user' as const, content: message },
    ];

    try {
      const res = await fetch('/api/agents/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, messages }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      if (isCurrentRun()) {
        setState(prev => ({ ...prev, isLoading: false }));
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!isCurrentRun()) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (!isCurrentRun()) break;
            
            // Convert events to trace logs
            switch (event.type) {
              case 'text':
                fullText += event.text || '';
                setResponseText(fullText);
                setTraceLogs(prev => [...prev, {
                  id: `ca-${Date.now()}-${Math.random().toString(36).substring(7)}`,
                  type: 'thought_stream',
                  text: event.text || '',
                  agentName: event.agentName,
                  timestamp: event.timestamp,
                }]);
                break;

              case 'tool_call':
                setTraceLogs(prev => [...prev, {
                  id: `ca-tc-${Date.now()}`,
                  type: 'progress',
                  text: `Using ${event.toolName}`,
                  secondary: stringifyTraceValue(event.toolArgs, 100),
                  agentName: event.agentName,
                  timestamp: event.timestamp,
                }]);
                break;

              case 'tool_result':
                setTraceLogs(prev => [...prev, {
                  id: `ca-tr-${Date.now()}`,
                  type: 'exploration',
                  text: `${event.toolName} completed`,
                  secondary: stringifyTraceValue(event.toolResult, 200),
                  agentName: event.agentName,
                  timestamp: event.timestamp,
                }]);
                break;

              case 'status':
                setState(prev => ({ ...prev, agentName: event.agentName || prev.agentName }));
                setTraceLogs(prev => [...prev, {
                  id: `ca-st-${Date.now()}`,
                  type: 'thought_stream',
                  text: event.text || '',
                  agentName: event.agentName,
                  timestamp: event.timestamp,
                }]);
                break;

              case 'ask_user':
                setTraceLogs(prev => [...prev, {
                  id: `ca-ask-${String(event.responseKey || Date.now())}`,
                  ...event,
                  type: 'ask_user',
                  text: event.question || 'Input needed',
                  agentName: event.agentName,
                  timestamp: event.timestamp || Date.now(),
                }]);
                break;

              case 'error':
                setState(prev => ({
                  ...prev,
                  isRunning: false,
                  isLoading: false,
                  error: event.text || 'Unknown error',
                }));
                break;

              case 'done':
                setState(prev => ({ ...prev, isRunning: false, isLoading: false }));
                break;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }

      if (buffer.trim() && isCurrentRun()) {
        try {
          const event = JSON.parse(buffer.trim());
          if (event.type === 'done') {
            setState(prev => ({ ...prev, isRunning: false, isLoading: false }));
          } else if (event.type === 'error') {
            setState(prev => ({ ...prev, isRunning: false, isLoading: false, error: event.text || 'Unknown error' }));
          }
        } catch {
          // Ignore trailing malformed JSON.
        }
      }

      if (isCurrentRun()) {
        setState(prev => ({ ...prev, isRunning: false, isLoading: false }));
      }

    } catch (err: any) {
      if (err.name !== 'AbortError' && isCurrentRun()) {
        setState(prev => ({
          ...prev,
          isRunning: false,
          isLoading: false,
          error: err.message,
        }));
      }
    } finally {
      if (isCurrentRun()) {
        abortRef.current = null;
      }
    }
  }, []);

  /** Stop the running agent */
  const stopAgent = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    runSeqRef.current += 1;
    setState(prev => ({ ...prev, isRunning: false, isLoading: false }));
  }, []);

  /** Clear state for a new conversation */
  const resetAgent = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    runSeqRef.current += 1;
    setState({
      agentId: null,
      agentName: '',
      isRunning: false,
      isLoading: false,
      error: null,
    });
    setTraceLogs([]);
    setResponseText('');
  }, []);

  /** List all available custom agents */
  const listAgents = useCallback(async (): Promise<Array<{
    agentId: string;
    name: string;
    status: string;
    mission: string;
  }>> => {
    try {
      const res = await fetch('/api/agents/list');
      const data = await res.json();
      if (!res.ok) return [];
      return (data.agents || []).filter((a: any) => a.status === 'ready');
    } catch {
      return [];
    }
  }, []);

  return {
    state,
    traceLogs,
    responseText,
    checkAgent,
    runAgent,
    stopAgent,
    resetAgent,
    listAgents,
  };
}
