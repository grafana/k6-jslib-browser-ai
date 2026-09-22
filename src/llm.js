import http from 'k6/http';
import { readEnv } from './env.js';

const DEFAULT_MODEL = 'claude-sonnet-5';

// Accepted names, checked in order, across both -e/--env flags and a
// project-root .env file (see env.js).
const API_KEY_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'];

// Minimal Anthropic client: sends a system+user prompt, returns the raw
// text response. No npm dependency - everything goes over k6/http, which
// works fine inside async functions.
export function createLLMClient(options = {}) {
  const model = options.model || readEnv('BROWSER_AI_MODEL') || DEFAULT_MODEL;
  const apiKey = options.apiKey || readEnv(...API_KEY_NAMES);

  if (!apiKey) {
    throw new Error(
      `browser-ai: missing API key. Set one of ${API_KEY_NAMES.join(', ')} ` +
        '(via -e, or a .env file at the project root) or pass { llmOptions: { apiKey } }.'
    );
  }

  function complete(systemPrompt, userPrompt) {
    const res = http.post(
      'https://api.anthropic.com/v1/messages',
      JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      {
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }
    );
    if (res.status !== 200) {
      throw new Error(`browser-ai: Anthropic API error ${res.status}: ${res.body}`);
    }
    const parsed = res.json();
    const block = (parsed.content || []).find((b) => b.type === 'text');
    return block ? block.text : '';
  }

  return { complete, model };
}
