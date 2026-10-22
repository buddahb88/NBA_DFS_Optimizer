/**
 * Scripted stand-in for the OpenAI client used by agenticChatService and
 * BaseAgent (chat.completions.create). For one eval case it plays both sides:
 *
 *   orchestrator  user turn -> delegate_to_agent({ agent, task });
 *                 tool turn -> final answer = the agent's message
 *   agent         user turn -> one call to `tool` with `args`;
 *                 tool turn -> final answer = the raw tool JSON
 *
 * So the real orchestrator, delegation, agent loop and tool executor run,
 * and the final answer carries the tool output. Every request is recorded
 * in `calls` ({ role, system, offered }) so tests can assert the tool was
 * offered to the model and named in its prompt.
 */

let nextId = 0;

const toolCall = (name, args) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call_${++nextId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
  }],
});

const answer = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });

export function scriptedClient({ agent, task, tool, args }) {
  const calls = [];
  const create = async (request) => {
    const offered = (request.tools || []).map(t => t.function.name);
    const role = offered.includes('delegate_to_agent') ? 'orchestrator' : 'agent';
    calls.push({ role, system: request.messages[0].content, offered });
    const last = request.messages[request.messages.length - 1];

    if (role === 'orchestrator') {
      if (last.role === 'user') return toolCall('delegate_to_agent', { agent, task });
      return answer(JSON.parse(last.content).message ?? last.content);
    }
    if (last.role === 'user') {
      // A model can only call what it is offered
      if (!offered.includes(tool)) return answer(`TOOL_NOT_OFFERED: ${tool}`);
      return toolCall(tool, args);
    }
    return answer(last.content);
  };
  return { calls, chat: { completions: { create } } };
}

/** Point agenticChatService and its sub-agents at `client`. */
export function useClient(service, client) {
  service.client = client;
  service.deploymentName = 'scripted';
  service.initialized = true;
  for (const agent of Object.values(service.agents)) {
    agent.client = client;
    agent.deploymentName = 'scripted';
  }
}
