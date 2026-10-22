import { describe, it, expect, vi } from 'vitest';
import { isClaudeEndpoint, runClaudeToolLoop, toClaudeHistory, toClaudeTool } from '../src/services/llm/claude.js';

// Fake Foundry client: returns the queued responses in order and records requests
const fakeClient = (...responses) => {
  const requests = [];
  return {
    requests,
    messages: {
      create: vi.fn(async (body) => {
        requests.push(structuredClone(body));
        return responses.shift();
      }),
    },
  };
};

const text = (t, stop_reason = 'end_turn') => ({ stop_reason, content: [{ type: 'text', text: t }] });
const toolUse = (...calls) => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    ...calls.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })),
  ],
});

describe('isClaudeEndpoint', () => {
  it('detects Foundry Claude endpoints and leaves Azure OpenAI alone', () => {
    expect(isClaudeEndpoint('https://r.services.ai.azure.com/anthropic/')).toBe(true);
    expect(isClaudeEndpoint('https://r.services.ai.azure.com/anthropic')).toBe(true);
    expect(isClaudeEndpoint('https://r.openai.azure.com')).toBe(false);
    expect(isClaudeEndpoint(undefined)).toBe(false);
  });
});

describe('toClaudeTool / toClaudeHistory', () => {
  it('maps an OpenAI function definition to a Claude tool', () => {
    const parameters = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(toClaudeTool({ name: 'sql', description: 'Run SQL', parameters }))
      .toEqual({ name: 'sql', description: 'Run SQL', input_schema: parameters });
  });

  it('keeps user/assistant text and drops leading assistant turns', () => {
    expect(toClaudeHistory([
      { role: 'assistant', content: 'Hi!' },
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'Who to stack?' },
      { role: 'assistant', content: 'SAS-OKC' },
      { role: 'user', content: '' },
    ])).toEqual([
      { role: 'user', content: 'Who to stack?' },
      { role: 'assistant', content: 'SAS-OKC' },
    ]);
  });
});

describe('runClaudeToolLoop', () => {
  it('returns the text when Claude answers without tools', async () => {
    const client = fakeClient(text('Play Wemby.'));
    const result = await runClaudeToolLoop({
      client, system: 'sys', messages: [{ role: 'user', content: 'hi' }], executeTool: vi.fn(),
    });
    expect(result).toMatchObject({ text: 'Play Wemby.', iterations: 1, maxIterationsReached: false });
    expect(client.requests[0]).toMatchObject({ system: 'sys', max_tokens: 16000 });
    expect(client.requests[0]).not.toHaveProperty('tools');
    expect(client.requests[0]).not.toHaveProperty('temperature');
  });

  it('runs parallel tool calls and returns all results in one user message', async () => {
    const client = fakeClient(
      toolUse(['t1', 'sql', { q: 'a' }], ['t2', 'sql', { q: 'b' }]),
      text('Done.'),
    );
    const executeTool = vi.fn(async (name, input) => `rows for ${input.q}`);

    const result = await runClaudeToolLoop({
      client, system: 's', messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'sql', description: '', input_schema: { type: 'object' } }], executeTool,
    });

    expect(result.text).toBe('Done.');
    expect(executeTool).toHaveBeenCalledTimes(2);
    const second = client.requests[1].messages;
    // assistant turn is replayed with its thinking block intact
    expect(second[1].role).toBe('assistant');
    expect(second[1].content[0].type).toBe('thinking');
    expect(second[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'rows for a' },
        { type: 'tool_result', tool_use_id: 't2', content: 'rows for b' },
      ],
    });
  });

  it('reports a failing tool as an error result instead of throwing', async () => {
    const client = fakeClient(toolUse(['t1', 'missing', {}]), text('Sorry.'));
    await runClaudeToolLoop({
      client, system: 's', messages: [{ role: 'user', content: 'go' }],
      executeTool: async () => { throw new Error('Tool missing not found'); },
    });
    expect(client.requests[1].messages[2].content[0])
      .toEqual({ type: 'tool_result', tool_use_id: 't1', content: 'Tool missing not found', is_error: true });
  });

  it('stops at maxIterations', async () => {
    const client = fakeClient(toolUse(['a', 'x', {}]), toolUse(['b', 'x', {}]));
    const result = await runClaudeToolLoop({
      client, system: 's', messages: [{ role: 'user', content: 'go' }],
      executeTool: async () => 'ok', maxIterations: 2,
    });
    expect(result.maxIterationsReached).toBe(true);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('turns a refusal into a readable message', async () => {
    const client = fakeClient({ stop_reason: 'refusal', content: [], stop_details: { explanation: 'policy' } });
    const result = await runClaudeToolLoop({
      client, system: 's', messages: [{ role: 'user', content: 'go' }], executeTool: vi.fn(),
    });
    expect(result).toMatchObject({ stopReason: 'refusal', text: "I can't help with that request: policy" });
  });
});
