import http from 'k6/http';
import { readEnv } from './env.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';

// TypeSafe's Jev is not a generative model - it answers typed Choice /
// Score / Noul questions against a fixed set of options and returns
// calibrated probabilities, with no free-text output. That's a good fit
// for "which element does this refer to" (choice) and "is this true"
// (noul), but it cannot produce arbitrary strings, so it can't replace
// ai.read() at all. See src/browser-ai.js for how the two are combined.
export function createJevClient(options = {}) {
  const apiKey = options.apiKey || readEnv('TYPESAFE_API_KEY', 'TYPESAFE_API_TOKEN', 'TYPESAFE_TOKEN');
  const model = options.model || readEnv('TYPESAFE_MODEL') || DEFAULT_MODEL;

  if (!apiKey) {
    throw new Error(
      'browser-ai: missing API key for TypeSafe/Jev. Set TYPESAFE_API_KEY ' +
        '(or TYPESAFE_API_TOKEN / TYPESAFE_TOKEN) via -e or a .env file, or pass ' +
        '{ jevOptions: { apiKey } }.'
    );
  }

  // state/questions follow https://docs.typesafe.ai/api - questions are
  // evaluated independently, in parallel, against the same state, and can
  // freely mix choice/score/noul in one request.
  function evaluate(state, questions) {
    const res = http.post(
      ENDPOINT,
      JSON.stringify({ state, model, questions }),
      {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
      }
    );
    if (res.status !== 200) {
      throw new Error(`browser-ai: TypeSafe/Jev API error ${res.status}: ${res.body}`);
    }
    return res.json().answers;
  }

  return { evaluate, model };
}
