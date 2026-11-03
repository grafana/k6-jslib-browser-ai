import http from 'k6/http';

const DEFAULT_MODEL = 'claude-sonnet-5';

// Accepted names, checked in order, in k6's environment (-e/--env flags or
// real environment variables, both exposed as __ENV).
const API_KEY_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'];

// First non-empty value among the candidate names, in order.
function readEnv(...names) {
  for (const name of names) {
    if (__ENV[name]) return __ENV[name];
  }
  return undefined;
}

// Minimal Anthropic client: sends a system+user prompt, returns the raw
// text response. No npm dependency - everything goes over k6/http, which
// works fine inside async functions.
export function createLLMClient(options = {}) {
  const model = options.model || readEnv('BROWSER_AI_MODEL') || DEFAULT_MODEL;
  const apiKey = options.apiKey || readEnv(...API_KEY_NAMES);
  // Anthropic's own safety classifier occasionally refuses a request that
  // has nothing objectionable in it - e.g. a page snapshot that happens to
  // combine a login form with a cookie-consent widget can read as
  // credential-phishing content to the classifier, even though it's just
  // x.com's homepage. Anthropic's docs call this out directly and recommend
  // a fallback model rather than trying to reword around it (the same page
  // snapshot that gets refused by one model routinely succeeds on another -
  // verified against claude-opus-5-5 refusing and claude-sonnet-5 answering
  // the identical prompt). Default to the library's own baseline model as
  // that fallback unless the caller is already using it or opts out with
  // `fallbackModel: null`.
  const fallbackModel =
    options.fallbackModel === undefined ? (model !== DEFAULT_MODEL ? DEFAULT_MODEL : undefined) : options.fallbackModel;

  if (!apiKey) {
    throw new Error(
      `browser-ai: missing API key. Set one of ${API_KEY_NAMES.join(', ')} ` +
        '(via -e or an environment variable) or pass { llmOptions: { apiKey } }.'
    );
  }

  function request(useModel, systemPrompt, userPrompt) {
    const res = http.post(
      'https://api.anthropic.com/v1/messages',
      JSON.stringify({
        model: useModel,
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
    return res.json();
  }

  function complete(systemPrompt, userPrompt) {
    let parsed = request(model, systemPrompt, userPrompt);

    if (parsed.stop_reason === 'refusal' && fallbackModel && fallbackModel !== model) {
      console.warn(
        `[browser-ai] ${model} refused a request (category: ` +
          `${(parsed.stop_details && parsed.stop_details.category) || 'unknown'}) - retrying once with ` +
          `fallbackModel=${fallbackModel}.`
      );
      parsed = request(fallbackModel, systemPrompt, userPrompt);
    }

    if (parsed.stop_reason === 'refusal') {
      const details = parsed.stop_details || {};
      throw new Error(
        `browser-ai: Anthropic refused the request (category: ${details.category || 'unknown'}): ` +
          `${details.explanation || 'no explanation given'}`
      );
    }

    const block = (parsed.content || []).find((b) => b.type === 'text');
    return block ? block.text : '';
  }

  return { complete, model, fallbackModel };
}
