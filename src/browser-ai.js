import { browser as k6Browser } from 'k6/browser';
import { createLLMClient } from './llm.js';
import { createJevClient } from './jev.js';
import { collectInteractiveElements } from './dom.js';

const DEFAULT_MAX_ELEMENTS = 150;
const DEFAULT_MAX_AGENT_STEPS = 10;
const DEFAULT_ACTION_TIMEOUT_MS = 8000;
const FORCEABLE_ACTIONS = ['click', 'check', 'uncheck', 'fill', 'type'];
// 0.5 is a coin flip, not a "yes" - elements with an uninformative
// description (no visible text) tend to cluster around 0.4-0.5 noise
// rather than 0, so the real threshold needs to sit clearly above that
// band. Verified against news.ycombinator.com: the correct "More" link
// scored 0.85 while unrelated upvote-arrow links clustered at 0.4-0.5.
const JEV_MATCH_THRESHOLD = 0.65;
const JEV_DONE_THRESHOLD = 0.8;

const DO_SYSTEM_PROMPT =
  'You control a web browser during a load test. You are given a natural ' +
  'language instruction and a JSON array of visible interactive elements. ' +
  'Pick exactly one element and one action that best satisfies the ' +
  'instruction. Reply with ONLY compact JSON, no prose, no markdown fences.';

const FIND_SYSTEM_PROMPT =
  'You inspect a web page during a load test. You are given a natural ' +
  'language instruction and a JSON array of visible interactive elements. ' +
  'Identify every element that matches the instruction. Reply with ONLY a ' +
  'compact JSON array, no prose, no markdown fences.';

const READ_SYSTEM_PROMPT =
  'You extract structured data from web page text during a load test. ' +
  'Reply with ONLY compact JSON, no prose, no markdown fences.';

const AGENT_SYSTEM_PROMPT =
  'You are driving a web browser toward a goal, one action at a time, ' +
  'during a load test. You are given the goal, the actions already taken, ' +
  'and the currently visible elements. First decide whether the goal is ' +
  'already satisfied. If it is, respond with {"done": true, "reason": ' +
  '<string>}. Otherwise choose exactly one next action and respond with ' +
  '{"done": false, "id": <element id>, "action": "click"|"fill"|"check"|' +
  '"uncheck"|"select"|"press", "value": <string, optional>}. ' +
  'Reply with ONLY compact JSON, no prose, no markdown fences.';

const VALUE_SYSTEM_PROMPT =
  'Extract or generate the single literal string value implied by a browser ' +
  'automation instruction (e.g. what to type into a field). Reply with ONLY ' +
  'that string - no quotes, no prose, no markdown fences.';

/**
 * Wraps a k6 browser `page` with a small `.ai` namespace (do / find / read /
 * agent) backed by an LLM (or, optionally, TypeSafe's Jev - see below),
 * while every native page method (goto, locator, evaluate, screenshot,
 * close, ...) keeps working untouched. The design is built around k6's
 * async browser module and load-testing constraints specifically: cost and
 * latency per VU per iteration, and no npm dependencies.
 *
 * `options.decisionProvider` picks how "which element / which action"
 * decisions get made:
 *   - 'llm' (default) - a single generative Anthropic call per decision,
 *     same as ai.read() uses.
 *   - 'jev' - TypeSafe's Jev model answers a typed Choice question ("which
 *     element") instead of generating JSON, which is faster and cheaper.
 *     Jev cannot generate free text at all, so a value that isn't literally
 *     quoted in the instruction (e.g. "type \"foo\" into...") or enumerable
 *     from the page (a <select>'s own options) still falls back to a single
 *     small LLM call - and ai.read() *always* uses the LLM, regardless of
 *     this setting, since it fundamentally requires generated text.
 */
export function browserAI(page, options = {}) {
  let llm = options.llm || null;
  let jev = options.jev || null;
  const decisionProvider = options.decisionProvider || 'llm';
  const maxElements = options.maxElements || DEFAULT_MAX_ELEMENTS;
  const actionTimeout = options.actionTimeout || DEFAULT_ACTION_TIMEOUT_MS;
  const verbose = !!options.verbose;

  function getLlm() {
    if (!llm) llm = createLLMClient(options.llmOptions || {});
    return llm;
  }

  function getJev() {
    if (!jev) jev = createJevClient(options.jevOptions || {});
    return jev;
  }

  // A click/fill that triggers navigation can tear down the page's JS
  // execution context right as the *next* evaluate() call fires, which
  // surfaces as a transient "Cannot find context with specified id" error
  // rather than anything wrong with the page or the instruction. Retrying
  // after the new context settles resolves it.
  async function evaluateStable(fn, arg) {
    try {
      return await page.evaluate(fn, arg);
    } catch (err) {
      // Not every error k6/browser throws is a real Error with a
      // .message - some transient CDP errors only have a useful toString().
      const text = (err && err.message) || String(err);
      if (!/context/i.test(text)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return page.evaluate(fn, arg);
    }
  }

  function warnIfTruncated(truncated) {
    if (!truncated) return;
    console.warn(
      `[browser-ai] element snapshot truncated at maxElements=${maxElements} - the right ` +
        'element may have been past this cap. Pass a higher options.maxElements for link-dense pages.'
    );
  }

  async function snapshot() {
    let { elements, truncated } = await evaluateStable(collectInteractiveElements, maxElements);
    warnIfTruncated(truncated);
    // An empty snapshot right after navigation usually means the page
    // fired 'networkidle' before client-side hydration actually added its
    // interactive elements, not that the page truly has none - retry once
    // rather than let callers (e.g. a Jev Choice question with zero
    // options) fail on a confusing downstream error.
    if (elements.length > 0) return elements;
    await new Promise((resolve) => setTimeout(resolve, 300));
    ({ elements, truncated } = await evaluateStable(collectInteractiveElements, maxElements));
    warnIfTruncated(truncated);
    return elements;
  }

  function askLlm(system, user) {
    const raw = getLlm().complete(system, user);
    if (verbose) console.log(`[browser-ai] llm raw response: ${raw}`);
    return parseJSON(raw);
  }

  async function runAction(locator, step, actionOpts) {
    switch (step.action) {
      case 'click':
        return locator.click(actionOpts);
      case 'fill':
      case 'type':
        return locator.fill(String(step.value ?? ''), actionOpts);
      case 'check':
        return locator.check(actionOpts);
      case 'uncheck':
        return locator.uncheck(actionOpts);
      case 'select':
        return locator.selectOption(step.value, actionOpts);
      case 'press':
        return locator.press(String(step.value ?? 'Enter'), actionOpts);
      default:
        throw new Error(`browser-ai: unsupported action "${step.action}"`);
    }
  }

  async function perform(step, actionOpts = {}) {
    const opts = { timeout: actionTimeout, ...actionOpts };
    // An element found inside a same-origin iframe (dom.js sets
    // frameSelector) isn't reachable via a plain page.locator() - it needs
    // page.frameLocator(theIframe).locator(theElement) instead.
    const locator = step.frameSelector
      ? page.frameLocator(step.frameSelector).locator(step.selector)
      : page.locator(step.selector);

    try {
      await runAction(locator, step, opts);
    } catch (err) {
      // Elements behind a styled label (custom checkboxes/toggles are the
      // common case) fail Playwright-style actionability checks even
      // though they're the right target - force the action once instead
      // of giving up, rather than eating the full default timeout.
      const canForce = FORCEABLE_ACTIONS.includes(step.action) && !opts.force;
      if (!canForce) throw err;
      await runAction(locator, step, { ...opts, force: true });
    }
    return step;
  }

  // Shared by ai.do() and ai.agent(): resolve an instruction/goal against
  // the current element snapshot into { id, action, value } (or, when
  // includeDone is set, { done: true, reason } once the goal is met).
  async function decideAction(instruction, elements, decideOpts = {}) {
    if (decisionProvider === 'jev') return decideWithJev(instruction, elements, decideOpts);
    return decideWithLlm(instruction, elements, decideOpts);
  }

  function decideWithLlm(instruction, elements, { includeDone, history } = {}) {
    if (includeDone) {
      const decision = askLlm(
        AGENT_SYSTEM_PROMPT,
        `Goal: ${instruction}\n\n` +
          `Actions taken so far: ${JSON.stringify(history || [])}\n\n` +
          elementPrompt(instruction, elements)
      );
      if (decision && decision.done) return { done: true, reason: decision.reason };
      return decision;
    }

    return askLlm(
      DO_SYSTEM_PROMPT,
      elementPrompt(instruction, elements) +
        '\n\nRespond with ONLY: {"id": <element id>, ' +
        '"action": "click"|"fill"|"check"|"uncheck"|"select"|"press", "value": <string, optional>}'
    );
  }

  // Jev answers a typed Choice question ("which element") instead of
  // generating JSON - see jev.js. Action *type* comes from the element's
  // own tag/attributes (deterministic, no inference needed), and a value
  // is resolved from the instruction text or the element's own options
  // where possible, only falling back to the LLM for genuinely generated
  // text (something Jev cannot produce at all).
  function decideWithJev(instruction, elements, { includeDone, history } = {}) {
    const client = getJev();
    const actedIds = (history || []).map((h) => h.id).filter((id) => id !== undefined);

    const questions = {
      target: {
        type: 'choice',
        instructions:
          `Which visible element does this instruction/goal refer to: "${instruction}"? ` +
          'The state includes any actions already taken - if the goal still needs more ' +
          'than one element acted on (e.g. "both checkboxes"), prefer an element not yet ' +
          'acted on over repeating an already-completed action.',
        criteria: elements.reduce((acc, el) => {
          acc[String(el.id)] = describeElement(el);
          return acc;
        }, {}),
      },
      checkbox_intent: {
        type: 'noul',
        instructions:
          'Only relevant if the target element is a checkbox: based on the instruction, ' +
          'should it end up checked (true) rather than unchecked (false)?',
      },
    };
    if (includeDone) {
      questions.done = {
        type: 'noul',
        instructions:
          `Considering the actions already taken (see state) and the goal "${instruction}", ` +
          'has the goal already been fully achieved, such that no further action is needed?',
      };
    }

    const state = { instruction, actions_already_taken: history || [] };
    const answers = client.evaluate(state, questions);
    if (verbose) {
      console.log(`[browser-ai:jev] state=${JSON.stringify(state)} answers=${JSON.stringify(answers)}`);
    }

    if (includeDone && answers.done && answers.done.noul >= JEV_DONE_THRESHOLD) {
      return { done: true, reason: `jev: done-confidence ${answers.done.noul.toFixed(2)}` };
    }

    const targetId = Number(answers.target && answers.target.choice);
    const target = elements[targetId];
    if (!target) {
      throw new Error(`browser-ai: (jev) could not resolve an element for "${instruction}"`);
    }

    let action = defaultActionForTag(target);
    let value;

    if (action === 'check') {
      action = answers.checkbox_intent && answers.checkbox_intent.noul >= 0.5 ? 'check' : 'uncheck';
    } else if (action === 'fill') {
      value = extractQuotedValue(instruction);
      if (value === undefined) value = generateValue(instruction);
    } else if (action === 'select') {
      value = resolveSelectValue(client, instruction, target);
    }

    return { id: targetId, action, value };
  }

  function resolveSelectValue(client, instruction, target) {
    const literal = extractQuotedValue(instruction);
    if (literal !== undefined) return literal;
    if (!Array.isArray(target.options) || target.options.length === 0) {
      return generateValue(instruction);
    }

    // A second, small Jev call: which of the <select>'s *actual* options
    // matches, rather than asking a generative model to invent a value.
    const answers = client.evaluate(instruction, {
      option: {
        type: 'choice',
        instructions: `Which option should be selected to satisfy: "${instruction}"?`,
        criteria: target.options.reduce((acc, label, idx) => {
          acc[String(idx)] = label;
          return acc;
        }, {}),
      },
    });
    const idx = Number(answers.option && answers.option.choice);
    return target.options[idx];
  }

  // The one place decisionProvider:'jev' still needs a real generative
  // call: a fill value that isn't quoted in the instruction and can't be
  // enumerated from the page. Kept to a single short completion.
  function generateValue(instruction) {
    return getLlm().complete(VALUE_SYSTEM_PROMPT, instruction).trim();
  }

  // Passing a {selector, action, value} object (e.g. from ai.find())
  // instead of a string skips the decision step entirely.
  async function doAction(instruction, actionOpts) {
    if (instruction && typeof instruction === 'object') {
      return perform(instruction, actionOpts);
    }

    const elements = await snapshot();
    if (elements.length === 0) {
      throw new Error(`browser-ai: no visible interactive elements found for "${instruction}"`);
    }
    const decision = await decideAction(instruction, elements);

    if (!decision || decision.id === undefined || decision.id === null) {
      throw new Error(`browser-ai: could not resolve an action for "${instruction}"`);
    }
    const target = elements[decision.id];
    if (!target) {
      throw new Error(`browser-ai: referenced an unknown element for "${instruction}"`);
    }

    return perform(
      {
        selector: target.selector,
        frameSelector: target.frameSelector,
        action: decision.action,
        value: decision.value,
      },
      actionOpts
    );
  }

  async function find(instruction) {
    const elements = await snapshot();
    if (decisionProvider === 'jev') return findWithJev(instruction, elements);
    return findWithLlm(instruction, elements);
  }

  function findWithLlm(instruction, elements) {
    const matches = askLlm(
      FIND_SYSTEM_PROMPT,
      elementPrompt(instruction, elements) +
        '\n\nRespond with ONLY a JSON array: ' +
        '[{"id": <element id>, "action": "click"|"fill"|"check"|"uncheck"|"select"|"press", "value": <string, optional>}]. ' +
        'Return [] if nothing matches.'
    );

    if (!Array.isArray(matches)) return [];
    return matches
      .filter((m) => elements[m.id])
      .map((m) => ({
        selector: elements[m.id].selector,
        frameSelector: elements[m.id].frameSelector,
        description: elements[m.id].text,
        action: m.action,
        value: m.value,
      }));
  }

  // Every element gets its own Noul ("does this match?") question, all
  // evaluated in parallel in a single request - no generated text needed,
  // so this is a full replacement for find(), not just a faster guess.
  function findWithJev(instruction, elements) {
    const client = getJev();
    const questions = elements.reduce((acc, el) => {
      acc[String(el.id)] = {
        type: 'noul',
        instructions: `Does this element satisfy "${instruction}"? Element: ${describeElement(el)}`,
      };
      return acc;
    }, {});
    if (Object.keys(questions).length === 0) return [];

    const answers = client.evaluate(instruction, questions);
    if (verbose) console.log(`[browser-ai:jev] find answers=${JSON.stringify(answers)}`);
    return elements
      .filter((el) => {
        const a = answers[String(el.id)];
        return a && a.noul >= JEV_MATCH_THRESHOLD;
      })
      .map((el) => ({
        selector: el.selector,
        frameSelector: el.frameSelector,
        description: el.text,
        action: defaultActionForTag(el),
        value: undefined,
      }));
  }

  // Always uses the generative LLM, regardless of decisionProvider: Jev
  // only answers typed questions and never emits free text.
  async function read(instruction, readOpts = {}) {
    const text = await evaluateStable(() => document.body.innerText.slice(0, 12000));
    const schemaHint = readOpts.schema
      ? `The result must match this JSON schema exactly:\n${JSON.stringify(readOpts.schema)}`
      : 'Return the most reasonable JSON representation of the requested data.';

    // document.body.innerText is unreliable for current form-control state
    // (a <select>'s innerText lists every option, not the selected one; it
    // says nothing about checkbox/radio checked state at all) - pass the
    // real values separately as ground truth for "what's selected/checked"
    // style questions.
    const elements = await snapshot();
    const controls = elements
      .filter((el) => el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea')
      .map((el) => ({
        tag: el.tag,
        type: el.type,
        selected_or_current_value: el.text,
        checked: el.checked,
        options: el.options,
      }));

    return askLlm(
      READ_SYSTEM_PROMPT,
      `Instruction: ${instruction}\n\n${schemaHint}\n\n` +
        'Current form control values (ground truth for what is currently ' +
        `selected/checked/filled in - prefer this over page text for that):\n${JSON.stringify(controls)}\n\n` +
        `Page text:\n${text}`
    );
  }

  async function agent(goal, agentOpts = {}) {
    const maxSteps = agentOpts.maxSteps || DEFAULT_MAX_AGENT_STEPS;
    const history = [];

    for (let step = 0; step < maxSteps; step++) {
      const elements = await snapshot();
      if (elements.length === 0) {
        throw new Error(`browser-ai: no visible interactive elements found for goal "${goal}"`);
      }
      const decision = await decideAction(goal, elements, { includeDone: true, history });

      if (decision && decision.done) {
        return { done: true, reason: decision.reason, steps: history };
      }
      if (!decision || decision.id === undefined || decision.id === null) {
        throw new Error(`browser-ai: agent could not resolve a next step for goal "${goal}"`);
      }

      const target = elements[decision.id];
      if (!target) {
        throw new Error(`browser-ai: agent referenced an unknown element for goal "${goal}"`);
      }

      const executed = await perform({
        selector: target.selector,
        frameSelector: target.frameSelector,
        action: decision.action,
        value: decision.value,
      });
      const record = { id: decision.id, description: target.text, ...executed };
      history.push(record);
      if (agentOpts.onStep) agentOpts.onStep(record, step);
    }

    return { done: false, reason: 'max steps reached', steps: history };
  }

  const ai = { do: doAction, find, read, agent };

  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === 'ai') return ai;
      if (prop === 'page') return target;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// browser.newPage() accepts k6's own page options (viewport, ...) and
// this library's (llm, decisionProvider, ...) in the same object - split
// them apart here rather than asking for two separate arguments.
const AI_OPTION_KEYS = [
  'llm',
  'llmOptions',
  'jev',
  'jevOptions',
  'maxElements',
  'actionTimeout',
  'verbose',
  'decisionProvider',
];

function splitAIOptions(options = {}) {
  const aiOptions = {};
  const nativeOptions = {};
  for (const key of Object.keys(options)) {
    (AI_OPTION_KEYS.includes(key) ? aiOptions : nativeOptions)[key] = options[key];
  }
  return { aiOptions, nativeOptions };
}

// Wraps k6/browser's `browser` (or a browser context) so .newPage() - and,
// for a browser, .newContext() - transparently return AI-ready pages.
// Every other method just passes through, so this is a drop-in
// replacement for `import { browser } from 'k6/browser'`, not a separate
// API to learn:
//
//   import { browser } from './src/browser-ai.js';
//   const page = await browser.newPage({ decisionProvider: 'jev' });
function wrapBrowserLike(target) {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'newPage') {
        return async (options) => {
          const { aiOptions, nativeOptions } = splitAIOptions(options);
          const hasNative = Object.keys(nativeOptions).length > 0;
          const page = await (hasNative ? obj.newPage(nativeOptions) : obj.newPage());
          return browserAI(page, aiOptions);
        };
      }
      if (prop === 'newContext') {
        return async (...args) => wrapBrowserLike(await obj.newContext(...args));
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });
}

export const browser = wrapBrowserLike(k6Browser);

function describeElement(el) {
  const parts = [el.tag];
  if (el.type) parts.push(`type=${el.type}`);
  if (el.role) parts.push(`role=${el.role}`);
  if (el.text) parts.push(`text="${el.text}"`);
  if (typeof el.checked === 'boolean') parts.push(`checked=${el.checked}`);
  if (Array.isArray(el.options)) parts.push(`options=[${el.options.join(', ')}]`);
  if (el.frameSelector) parts.push('(inside an embedded frame)');
  return parts.join(' ');
}

function defaultActionForTag(el) {
  if (el.tag === 'select') return 'select';
  if (el.tag === 'input') {
    if (el.type === 'checkbox') return 'check';
    return el.type === 'radio' || el.type === 'submit' || el.type === 'button' ? 'click' : 'fill';
  }
  if (el.tag === 'textarea') return 'fill';
  return 'click'; // a, button, summary, [role], [onclick]
}

function extractQuotedValue(instruction) {
  const match = instruction.match(/"([^"]*)"|'([^']*)'/);
  if (!match) return undefined;
  return match[1] !== undefined ? match[1] : match[2];
}

function elementPrompt(instruction, elements) {
  return (
    `Instruction: ${instruction}\n\n` +
    'Page elements (JSON array, "id" is the index you must reference):\n' +
    JSON.stringify(elements)
  );
}

function parseJSON(raw) {
  const cleaned = raw
    .trim()
    .replace(/^```(json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`browser-ai: failed to parse LLM response as JSON: ${cleaned}`);
  }
}

export { createLLMClient } from './llm.js';
export { createJevClient } from './jev.js';
