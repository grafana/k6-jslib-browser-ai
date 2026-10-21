import http from 'k6/http';
import { readEnv } from './env.js';

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-5',
    defaultMaxTokens: 1024,
    // Accepted names, checked in order, across both -e/--env flags and a
    // project-root .env file (see env.js).
    apiKeyNames: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4.1',
    // Reasoning models (o-series, gpt-5) count hidden reasoning against this
    // budget, so leave headroom beyond the visible JSON reply.
    defaultMaxTokens: 4096,
    apiKeyNames: ['OPENAI_API_KEY'],
  },
};

// An explicit provider (option, then BROWSER_AI_PROVIDER) wins; then a
// recognisable model name (gpt-*, o1/o3/..., claude-*); otherwise pick
// whichever provider has a key available, preferring Anthropic.
function resolveProvider(options) {
  const raw = options.provider || readEnv('BROWSER_AI_PROVIDER');
  if (raw) {
    const explicit = String(raw).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, explicit)) {
      throw new Error(
        `browser-ai: unknown provider "${raw}". Use one of ${Object.keys(PROVIDERS).join(', ')}.`
      );
    }
    return explicit;
  }
  const model = options.model || readEnv('BROWSER_AI_MODEL');
  if (model) {
    if (/^(gpt-|chatgpt-|o\d)/i.test(model)) return 'openai';
    if (/^claude/i.test(model)) return 'anthropic';
  }
  if (options.apiKey) return 'anthropic';
  for (const name of Object.keys(PROVIDERS)) {
    if (readEnv(...PROVIDERS[name].apiKeyNames)) return name;
  }
  return 'anthropic';
}

// Minimal Anthropic/OpenAI client: sends a system+user prompt, returns the
// raw text response. No npm dependency - everything goes over k6/http, which
// works fine inside async functions.
export function createLLMClient(options = {}) {
  const provider = resolveProvider(options);
  const { label, defaultModel, defaultMaxTokens, apiKeyNames } = PROVIDERS[provider];
  const model = options.model || readEnv('BROWSER_AI_MODEL') || defaultModel;
  const maxTokens = options.maxTokens || defaultMaxTokens;
  const apiKey = options.apiKey || readEnv(...apiKeyNames);
  // Anthropic's own safety classifier occasionally refuses a request that
  // has nothing objectionable in it - e.g., a page snapshot that happens to
  // combine a login form with a cookie-consent widget can read as
  // credential-phishing content to the classifier, even though it's just
  // x.com's homepage. Anthropic's docs call this out directly and recommend
  // a fallback model rather than trying to reword around it (the same page
  // snapshot that gets refused by one model routinely succeeds on another -
  // verified against claude-opus-5-5 refusing and claude-sonnet-5 answering
  // the identical prompt). Default to the library's own baseline model as
  // that fallback unless the caller is already using it or opts out with
  // `fallbackModel: null`. OpenAI has no equivalent, so it only falls back
  // when the caller asks for it explicitly.
  const fallbackModel =
    options.fallbackModel === undefined
      ? provider === 'anthropic' && model !== defaultModel
        ? defaultModel
        : undefined
      : options.fallbackModel;

  if (!apiKey) {
    throw new Error(
      `browser-ai: missing API key. Set one of ${apiKeyNames.join(', ')} ` +
        '(via -e, or a .env file at the project root) or pass { llmOptions: { apiKey } }.'
    );
  }

  // Each request returns { text, refusal }, where refusal is null or
  // { category, explanation }.
  function requestAnthropic(useModel, systemPrompt, userPrompt) {
    const res = http.post(
      'https://api.anthropic.com/v1/messages',
      JSON.stringify({
        model: useModel,
        max_tokens: maxTokens,
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
      throw new Error(`browser-ai: ${label} API error ${res.status}: ${res.body}`);
    }
    const parsed = res.json();
    if (parsed.stop_reason === 'refusal') {
      const details = parsed.stop_details || {};
      return { text: '', refusal: { category: details.category, explanation: details.explanation } };
    }
    const block = (parsed.content || []).find((b) => b.type === 'text');
    return { text: block ? block.text : '', refusal: null, stopReason: parsed.stop_reason };
  }

  function requestOpenAI(useModel, systemPrompt, userPrompt) {
    const res = http.post(
      'https://api.openai.com/v1/chat/completions',
      JSON.stringify({
        model: useModel,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
      }
    );
    if (res.status !== 200) {
      throw new Error(`browser-ai: ${label} API error ${res.status}: ${res.body}`);
    }
    const choice = (res.json().choices || [])[0] || {};
    const message = choice.message || {};
    if (message.refusal) {
      return { text: '', refusal: { category: 'refusal', explanation: message.refusal } };
    }
    return { text: message.content || '', refusal: null, stopReason: choice.finish_reason };
  }

  const request = provider === 'openai' ? requestOpenAI : requestAnthropic;

  function complete(systemPrompt, userPrompt) {
    let result = request(model, systemPrompt, userPrompt);

    if (result.refusal && fallbackModel && fallbackModel !== model) {
      console.warn(
        `[browser-ai] ${model} refused a request (category: ` +
          `${result.refusal.category || 'unknown'}) - retrying once with ` +
          `fallbackModel=${fallbackModel}.`
      );
      result = request(fallbackModel, systemPrompt, userPrompt);
    }

    if (result.refusal) {
      throw new Error(
        `browser-ai: ${label} refused the request (category: ${result.refusal.category || 'unknown'}): ` +
          `${result.refusal.explanation || 'no explanation given'}`
      );
    }

    // An empty reply would otherwise surface later as a confusing JSON parse
    // error. Reasoning models can spend the whole token budget thinking.
    if (!result.text) {
      throw new Error(
        `browser-ai: ${label} returned an empty response (stop reason: ${result.stopReason || 'unknown'}).` +
          (result.stopReason === 'length' || result.stopReason === 'max_tokens'
            ? ' The token budget may have been exhausted; reasoning models can use it all thinking.'
            : '')
      );
    }

    return result.text;
  }

  return { complete, model, fallbackModel, provider };
}
