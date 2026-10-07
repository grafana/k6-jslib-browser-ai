import { browser as k6Browser } from 'k6/browser';
import { createLLMClient } from './llm.js';
import { createJevClient } from './jev.js';
import { collectInteractiveElements, collectVisibleText } from './dom.js';

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
const WAIT_MET_THRESHOLD = 0.65;
const DEFAULT_WAIT_TIMEOUT_MS = 10000;
const DEFAULT_WAIT_INTERVAL_MS = 500;
// Typing into a search box often triggers an async autocomplete update
// that transiently changes the element list - poll until the count stops
// changing instead of guessing a fixed delay.
const SETTLE_POLL_MS = 150;
const SETTLE_MAX_WAIT_MS = 2000;
// A snapshot-resolved target can end up under a dropdown/overlay by the
// time the action runs - hit-test its own center and wait it out instead
// of letting a plain actionability timeout run its full course.
const OCCLUSION_POLL_MS = 150;
const OCCLUSION_MAX_WAIT_MS = 1200;
// Re-deriving the exact same action from a *fresh* snapshot this many
// times in a row is a click-loop, not deliberate repetition - stop rather
// than burn the rest of maxSteps on it.
const STUCK_REPEAT_THRESHOLD = 3;

const ACT_SYSTEM_PROMPT =
  'You control a web browser during a load test. You are given a natural ' +
  'language instruction and a JSON array of visible interactive elements. ' +
  'If exactly one element and action clearly satisfy the instruction, pick ' +
  'them. If the instruction needs content revealed that is not in the ' +
  'element list yet, respond with "scroll" (no element needed) instead. ' +
  "If nothing visible plausibly satisfies it and scrolling would not help " +
  "either - it's about a different page, a different app, or simply is " +
  'not there - say so instead of guessing the closest-sounding element. ' +
  'Never force a pick just to produce an answer. Reply with ONLY compact ' +
  'JSON, no prose, no markdown fences.';

const OBSERVE_SYSTEM_PROMPT =
  'You inspect a web page during a load test. You are given a natural ' +
  'language instruction and a JSON array of visible interactive elements. ' +
  'Identify every element that matches the instruction. Reply with ONLY a ' +
  'compact JSON array, no prose, no markdown fences.';

const EXTRACT_SYSTEM_PROMPT =
  'You extract structured data from web page text during a load test. ' +
  'Reply with ONLY compact JSON, no prose, no markdown fences.';

const AGENT_SYSTEM_PROMPT =
  'You are driving a web browser toward a goal, one action at a time, ' +
  'during a load test. You are given the goal, the actions already taken, ' +
  'and the currently visible elements. First decide whether the goal is ' +
  'already satisfied. If it is, respond with {"done": true, "reason": ' +
  '<string>}. Otherwise choose exactly one next action and respond with ' +
  '{"done": false, "id": <element id, omit for "scroll">, "action": "click"|' +
  '"fill"|"check"|"uncheck"|"select"|"press"|"scroll", "value": <string, ' +
  'optional - for "scroll" use "down" or "up">}. Use "scroll" (no element ' +
  'needed) when the goal needs content revealed that is not in the element ' +
  'list yet. Reply with ONLY compact JSON, no prose, no markdown fences.';

const VALUE_SYSTEM_PROMPT =
  'Extract or generate the single literal string value implied by a browser ' +
  'automation instruction (e.g. what to type into a field). Reply with ONLY ' +
  'that string - no quotes, no prose, no markdown fences.';

// Shared by wait() (polls this) and assert() (checks it once) - both
// ultimately ask the same question, "is this condition currently true on
// the page?". The reason is unused by wait() but gives assert() a
// meaningful failure message.
const CONDITION_SYSTEM_PROMPT =
  'You check whether a condition about a web page is currently true during ' +
  'a load test. You are given the condition, the page URL, and the page\'s ' +
  'visible text. Reply with ONLY compact JSON: {"met": true|false, "reason": ' +
  '<string>}, no prose, no markdown fences.';

// A separate prompt/call from AGENT_SYSTEM_PROMPT, grounded in plain page
// text rather than the same element list the acting decision used - see
// verifyGoalMet() for why a self-reported "done" isn't trusted on its own.
const VERIFY_DONE_SYSTEM_PROMPT =
  'You independently audit whether a browser-automation goal has actually ' +
  'been achieved, based only on the current page\'s visible text and URL - ' +
  'not on the acting model\'s own claim. Be skeptical: if the page doesn\'t ' +
  'clearly show the goal is met, say it is not. Reply with ONLY compact ' +
  'JSON: {"met": true|false}, no prose, no markdown fences.';

// Module-level (not per browserAI() call) so it's shared across every
// act()/agent() decision in this process - a fresh page wrap on the next
// iteration still remembers what earlier ones did. This is purely extra
// context fed into the decision prompt to help disambiguate ("the other
// checkbox", "already navigated past login") - it never skips a decision
// call. Capped so a long-running script doesn't grow the prompt forever.
const CONTEXT_LIMIT = 20;
const sharedContext = [];

function recordContext(entry) {
  sharedContext.push(entry);
  if (sharedContext.length > CONTEXT_LIMIT) sharedContext.shift();
}

/**
 * Wraps a k6 browser `page` with a small `.ai` namespace (act / observe /
 * extract / agent / wait / assert) backed by an LLM (or, optionally,
 * TypeSafe's Jev - see below), while every native page method (goto,
 * locator, evaluate, screenshot, close, ...) keeps working untouched. The
 * design is built around k6's async browser module and load-testing
 * constraints specifically: cost and latency per VU per iteration, and no
 * npm dependencies.
 *
 * `options.decisionProvider` picks how "which element / which action"
 * decisions get made:
 *   - 'llm' (default) - a single generative Anthropic call per decision,
 *     same as ai.extract() uses.
 *   - 'jev' - TypeSafe's Jev model answers a typed Choice question ("which
 *     element") instead of generating JSON, which is faster and cheaper.
 *     Jev cannot generate free text at all, so a value that isn't literally
 *     quoted in the instruction (e.g. "type \"foo\" into...") or enumerable
 *     from the page (a <select>'s own options) still falls back to a single
 *     small LLM call - and ai.extract() *always* uses the LLM, regardless of
 *     this setting, since it fundamentally requires generated text.
 *
 * `options.context` (default off) feeds a rolling log of past act()/agent()
 * decisions - shared across every browserAI() call in this process, so it
 * survives across iterations, not just within one page - into every future
 * decision's prompt, purely to help it reason (e.g. disambiguate "the other
 * checkbox," know it already navigated somewhere). It never skips a call.
 */
export function browserAI(page, options = {}) {
  let llm = options.llm || null;
  let jev = options.jev || null;
  const decisionProvider = options.decisionProvider || 'llm';
  const maxElements = options.maxElements || DEFAULT_MAX_ELEMENTS;
  const actionTimeout = options.actionTimeout || DEFAULT_ACTION_TIMEOUT_MS;
  const contextEnabled = !!options.context;

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

  // Fingerprints of common bot-detection interstitials, checked whenever a
  // snapshot is empty or an action never becomes actionable - a challenge
  // page often still has a few real elements (a spinner, a skip-nav link),
  // just none of them the thing the instruction asked for. This only makes
  // the error honest about *why*; it never tries to solve or bypass one.
  const BOT_CHALLENGE_MARKERS = [
    'captcha-delivery.com',
    'perimeterx',
    '_px-captcha',
    'cf-chl',
    'checking your browser',
    'hcaptcha.com',
    'g-recaptcha',
  ];

  function pageHtmlSnippet() {
    return document.documentElement.outerHTML.slice(0, 4000);
  }

  async function botChallengeHint() {
    try {
      const html = (await evaluateStable(pageHtmlSnippet)).toLowerCase();
      const hit = BOT_CHALLENGE_MARKERS.find((m) => html.includes(m));
      if (hit) {
        return (
          ` - the page looks like a bot-detection/CAPTCHA challenge (matched "${hit}"). ` +
          'browser-ai does not attempt to bypass these.'
        );
      }
    } catch (err) {
      // Best-effort diagnostic only - never let it mask the real error.
    }
    return '';
  }

  // Polls the raw element count (cheap - no maxElements truncation warning,
  // no empty-snapshot retry, just "how many interactive elements right now")
  // until two consecutive reads agree, meaning whatever async UI update was
  // in flight (autocomplete, a suggestions dropdown, ...) has settled.
  async function waitForStableElementCount() {
    const start = Date.now();
    let prevCount = -1;
    while (Date.now() - start < SETTLE_MAX_WAIT_MS) {
      const { elements } = await evaluateStable(collectInteractiveElements, maxElements);
      if (elements.length === prevCount) return;
      prevCount = elements.length;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
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
    console.debug(`[browser-ai] llm prompt: ${user}`);
    const raw = getLlm().complete(system, user);
    console.debug(`[browser-ai] llm raw response: ${raw}`);
    return parseJSON(raw);
  }

  // Self-contained (no closures over outer scope) - serialized and run in
  // the browser context via page.evaluate, same convention as dom.js.
  function reachabilityProbe({ selector, frameSelector }) {
    let doc = document;
    if (frameSelector) {
      const frame = document.querySelector(frameSelector);
      const innerDoc = frame && frame.contentDocument;
      if (!innerDoc) return { exists: false };
      doc = innerDoc;
    }
    const el = doc.querySelector(selector);
    if (!el) return { exists: false };

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { exists: true, reachable: false, reason: 'zero-size' };

    const view = doc.defaultView;
    const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), view.innerWidth - 1);
    const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), view.innerHeight - 1);
    const hit = doc.elementFromPoint(cx, cy);
    if (!hit) return { exists: true, reachable: false, reason: 'nothing at its own center point' };

    // Reachable if the hit-test lands on the element itself, a descendant
    // (e.g. an icon/span inside a button), or an ancestor (normal nested
    // markup) - anything else is a genuinely unrelated element sitting on
    // top of it.
    if (hit === el || el.contains(hit) || hit.contains(el)) return { exists: true, reachable: true };

    const describe = (n) => {
      const cls = typeof n.className === 'string' ? n.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${cls ? '.' + cls : ''}`;
    };
    return { exists: true, reachable: false, reason: 'covered', coveredBy: describe(hit) };
  }

  // Polls the hit-test above until the target either becomes reachable or
  // the wait runs out, rather than assuming a single check catches a
  // transient overlay (an animating dropdown, a closing modal) mid-motion.
  async function waitUntilReachable(step) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < OCCLUSION_MAX_WAIT_MS) {
      last = await evaluateStable(reachabilityProbe, { selector: step.selector, frameSelector: step.frameSelector });
      if (!last.exists || last.reachable) return last;
      await new Promise((resolve) => setTimeout(resolve, OCCLUSION_POLL_MS));
    }
    return last;
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

    // Only meaningful for the same actions force-retrying below applies to
    // - a snapshot-resolved target can be a moment out of date, and this
    // catches "something else is on top of it right now" specifically,
    // as opposed to "it's disabled" or "it doesn't exist" (already ruled
    // out at snapshot time).
    let occlusion = null;
    if (FORCEABLE_ACTIONS.includes(step.action)) {
      const probe = await waitUntilReachable(step);
      if (probe && probe.exists && !probe.reachable) occlusion = probe;
    }

    try {
      await runAction(locator, step, opts);
    } catch (err) {
      // Elements behind a styled label (custom checkboxes/toggles are the
      // common case) fail Playwright-style actionability checks even
      // though they're the right target - force the action once instead
      // of giving up, rather than eating the full default timeout.
      const canForce = FORCEABLE_ACTIONS.includes(step.action) && !opts.force;
      if (!canForce) throw await withActionFailureHint(err, occlusion);
      try {
        await runAction(locator, step, { ...opts, force: true });
      } catch (forceErr) {
        throw await withActionFailureHint(forceErr, occlusion);
      }
    }
    if (step.action === 'fill' || step.action === 'type') {
      await waitForStableElementCount();
    }
    return step;
  }

  // Self-contained (no closures over outer scope) - same convention as
  // reachabilityProbe/pageHtmlSnippet above.
  function scrollByViewport(direction) {
    window.scrollBy(0, direction === 'up' ? -window.innerHeight : window.innerHeight);
  }

  // "scroll" has no element target - by design, it exists to reveal
  // content that isn't in the DOM yet (virtualized lists, infinite
  // scroll), so there's nothing yet to target by id; anything already
  // rendered-but-off-screen is reached for free by perform()'s own
  // actionability checks. Reuses the same settle-poll perform() runs
  // after fill/type, since a scroll can just as easily trigger an async
  // lazy-load.
  async function performScroll(step) {
    await evaluateStable(scrollByViewport, step.value);
    await waitForStableElementCount();
    return step;
  }

  // A target element that never becomes actionable - the actual symptom
  // here was a real Playwright timeout clicking a legitimate-looking
  // element, not an empty snapshot - has two known causes worth telling
  // apart instead of leaving as a bare timeout: something else is sitting
  // on top of it right now (the occlusion probe above already checked and
  // waited for this specifically), or the whole page is a bot-detection
  // interstitial (e.g. eBay serving a "checking your browser" page
  // mid-session, after a search box was typed into). Enrich rather than
  // replace the original error so a genuinely bad selector still reads
  // like one.
  async function withActionFailureHint(err, occlusion) {
    const text = (err && err.message) || String(err);
    if (occlusion) {
      const covering = occlusion.coveredBy ? ` by "${occlusion.coveredBy}"` : '';
      return new Error(
        `${text} - the target element exists but was covered${covering} the last time it was checked, ` +
          'not a wrong element pick.'
      );
    }
    const hint = await botChallengeHint();
    if (!hint) return err;
    return new Error(`${text}${hint}`);
  }

  // Shared by ai.act() and ai.agent(): resolve an instruction/goal against
  // the current element snapshot into { id, action, value } (or, when
  // includeDone is set, { done: true, reason } once the goal is met).
  async function decideAction(instruction, elements, decideOpts = {}) {
    if (decisionProvider === 'jev') return decideWithJev(instruction, elements, decideOpts);
    return decideWithLlm(instruction, elements, decideOpts);
  }

  function decideWithLlm(instruction, elements, { includeDone, history } = {}) {
    const priorContext = contextNote();
    if (includeDone) {
      const decision = askLlm(
        AGENT_SYSTEM_PROMPT,
        `Goal: ${instruction}\n\n` +
          `Actions taken so far: ${JSON.stringify(history || [])}\n\n` +
          elementPrompt(instruction, elements) +
          priorContext
      );
      if (decision && decision.done) return { done: true, reason: decision.reason };
      return decision;
    }

    return askLlm(
      ACT_SYSTEM_PROMPT,
      elementPrompt(instruction, elements) +
        priorContext +
        '\n\nRespond with ONLY: {"id": <element id, omit for "scroll">, ' +
        '"action": "click"|"fill"|"check"|"uncheck"|"select"|"press"|"scroll", ' +
        '"value": <string, optional - for "scroll" use "down" or "up">} if one element clearly ' +
        'matches or scrolling would help, or {"id": null, "reason": <string explaining what is ' +
        'missing>} if nothing on the page plausibly satisfies the instruction even after scrolling.'
    );
  }

  // Empty unless options.context is on - see sharedContext above.
  function contextNote() {
    if (!contextEnabled || sharedContext.length === 0) return '';
    return (
      '\n\nActions taken earlier in this run (for context - may be on a ' +
      `different page):\n${JSON.stringify(sharedContext)}`
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
    } else {
      // Only for a plain act() - not agent(), which already has its own
      // done/stuck-loop handling for "nothing good to click yet". `target`
      // above is a forced Choice with no abstain option, so without this
      // a page with nothing related to the instruction still gets a
      // confident-looking pick instead of an honest refusal - same
      // problem observeWithJev's per-element threshold already avoids.
      questions.plausible = {
        type: 'noul',
        instructions:
          `Does ANY visible element on the page plausibly satisfy this instruction at all: ` +
          `"${instruction}"? Answer false if nothing on the page is remotely related to it, ` +
          'rather than picking the closest-sounding guess. ' +
          `Visible elements: ${JSON.stringify(elements.map(describeElement))}`,
      };
    }

    const state = { instruction, actions_already_taken: history || [] };
    if (contextEnabled && sharedContext.length > 0) {
      state.actions_taken_earlier_in_this_run = sharedContext;
    }
    const answers = client.evaluate(state, questions);
    console.debug(`[browser-ai:jev] state=${JSON.stringify(state)} answers=${JSON.stringify(answers)}`);

    if (includeDone && answers.done && answers.done.noul >= JEV_DONE_THRESHOLD) {
      return { done: true, reason: `jev: done-confidence ${answers.done.noul.toFixed(2)}` };
    }

    if (!includeDone && answers.plausible && answers.plausible.noul < JEV_MATCH_THRESHOLD) {
      throw new Error(
        `browser-ai: no element on the page satisfies "${instruction}" ` +
          `(jev plausibility ${answers.plausible.noul.toFixed(2)})`
      );
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

  // Passing a {selector, action, value} object (e.g. from ai.observe())
  // instead of a string skips the decision step entirely.
  //
  // actionOpts.secrets lets an instruction reference a value by name
  // (`type {{password}} into the password field`) instead of containing
  // it literally: the LLM/Jev decision only ever sees the placeholder
  // token, and it's swapped for the real value right before the action
  // actually runs. This is the only case act() needs a real secret at all
  // - a value quoted directly in the instruction still goes through the
  // decision step (and, for the LLM path, the prompt) as-is.
  async function act(instruction, actionOpts = {}) {
    const { secrets, variables, ...playwrightOpts } = actionOpts;

    if (instruction && typeof instruction === 'object') {
      if (instruction.action === 'scroll') return performScroll(instruction);
      return perform(instruction, playwrightOpts);
    }

    // variables are resolved into the instruction text up front, so the
    // LLM/Jev decision sees the real value - unlike secrets, which stay as
    // a placeholder through the decision and are only filled into the
    // final value. Use variables for anything that isn't sensitive.
    const resolvedInstruction = substitutePlaceholders(instruction, variables);

    const elements = await snapshot();
    if (elements.length === 0) {
      throw new Error(
        `browser-ai: no visible interactive elements found for "${resolvedInstruction}"${await botChallengeHint()}`
      );
    }
    const decision = await decideAction(resolvedInstruction, elements);

    if (decision && decision.action === 'scroll') {
      const scrollStep = { action: 'scroll', value: decision.value };
      await performScroll(scrollStep);
      if (contextEnabled) {
        recordContext({ instruction: resolvedInstruction, description: `scrolled ${scrollStep.value}`, action: 'scroll' });
      }
      return scrollStep;
    }

    if (!decision || decision.id === undefined || decision.id === null) {
      // decision.reason is present when the model explicitly declined
      // (see ACT_SYSTEM_PROMPT) rather than when the response was just
      // malformed/empty - surface it when we have it, since it's the
      // single most useful signal for "why didn't this work".
      const reason = decision && decision.reason ? `: ${decision.reason}` : '';
      throw new Error(`browser-ai: no element on the page satisfies "${resolvedInstruction}"${reason}`);
    }
    const target = elements[decision.id];
    if (!target) {
      throw new Error(`browser-ai: referenced an unknown element for "${resolvedInstruction}"`);
    }

    // Returned as-is (placeholder intact), never the value with secrets
    // substituted in, so logging/inspecting the result can't leak one.
    const step = {
      selector: target.selector,
      frameSelector: target.frameSelector,
      action: decision.action,
      value: decision.value,
    };
    await perform({ ...step, value: substitutePlaceholders(step.value, secrets) }, playwrightOpts);
    // Placeholder value only (if any) - never the secret-substituted one.
    if (contextEnabled) {
      recordContext({ instruction: resolvedInstruction, description: target.text, action: step.action });
    }
    return step;
  }

  async function observe(instruction, observeOpts = {}) {
    const resolvedInstruction = substitutePlaceholders(instruction, observeOpts.variables);
    const elements = await snapshot();
    if (decisionProvider === 'jev') return observeWithJev(resolvedInstruction, elements);
    return observeWithLlm(resolvedInstruction, elements);
  }

  function observeWithLlm(instruction, elements) {
    const matches = askLlm(
      OBSERVE_SYSTEM_PROMPT,
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
  // so this is a full replacement for observe(), not just a faster guess.
  function observeWithJev(instruction, elements) {
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
    console.debug(`[browser-ai:jev] observe answers=${JSON.stringify(answers)}`);
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
  async function extract(instruction, extractOpts = {}) {
    const resolvedInstruction = substitutePlaceholders(instruction, extractOpts.variables);
    const text = await evaluateStable(collectVisibleText, 12000);
    const schemaHint = extractOpts.schema
      ? `The result must match this JSON schema exactly:\n${JSON.stringify(extractOpts.schema)}`
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
      EXTRACT_SYSTEM_PROMPT,
      `Instruction: ${resolvedInstruction}\n\n${schemaHint}\n\n` +
        'Current form control values (ground truth for what is currently ' +
        `selected/checked/filled in - prefer this over page text for that):\n${JSON.stringify(controls)}\n\n` +
        `Page text:\n${text}`
    );
  }

  // Polls a natural-language condition against the page instead of a
  // hardcoded signal like a URL substring or a specific element - useful
  // for redirects/transitions whose timing isn't consistent (e.g. an app
  // that takes a variable amount of time to leave its login page) without
  // baking that one app's behavior into the wait itself. Throws on timeout.
  async function wait(condition, waitOpts = {}) {
    const timeout = waitOpts.timeout || DEFAULT_WAIT_TIMEOUT_MS;
    const interval = waitOpts.interval || DEFAULT_WAIT_INTERVAL_MS;
    const resolvedCondition = substitutePlaceholders(condition, waitOpts.variables);
    const start = Date.now();

    for (;;) {
      const { met } = await checkCondition(resolvedCondition);
      if (met) return;
      if (Date.now() - start >= timeout) {
        throw new Error(`browser-ai: wait() timed out after ${timeout}ms waiting for "${resolvedCondition}"`);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  // A single, non-polling judgment - unlike wait(), never retried, since
  // the point is to check *this* moment's state and fail loudly if it
  // doesn't hold, not to wait for it to become true.
  async function assert(assertion, assertOpts = {}) {
    const resolvedAssertion = substitutePlaceholders(assertion, assertOpts.variables);
    const { met, reason } = await checkCondition(resolvedAssertion);
    if (met) return;
    throw new Error(
      `browser-ai: assertion failed: "${resolvedAssertion}" - ${reason || 'condition was not met'}`
    );
  }

  async function checkConditionWithLlm(condition) {
    const text = await evaluateStable(collectVisibleText, 4000);
    const decision = askLlm(
      CONDITION_SYSTEM_PROMPT,
      `Condition: ${condition}\n\nCurrent URL: ${page.url()}\n\nPage text:\n${text}`
    );
    return { met: !!(decision && decision.met), reason: decision && decision.reason };
  }

  async function checkConditionWithJev(condition) {
    const client = getJev();
    const text = await evaluateStable(collectVisibleText, 4000);
    const answers = client.evaluate(
      { condition, url: page.url(), page_text: text },
      { met: { type: 'noul', instructions: `Is the following currently true about the page: ${condition}` } }
    );
    return { met: !!(answers.met && answers.met.noul >= WAIT_MET_THRESHOLD) };
  }

  async function checkCondition(condition) {
    return decisionProvider === 'jev' ? checkConditionWithJev(condition) : checkConditionWithLlm(condition);
  }

  // Independently audits a self-reported agent() "done" against the
  // page's own visible text, rather than trusting the same decision call
  // that produced it - a genuinely different signal (plain text vs. the
  // element-list-grounded decision), not just asking the same question
  // twice. Always the LLM path regardless of decisionProvider: the point
  // is a second, differently-grounded check, not a cheaper one.
  async function verifyGoalMet(goal, history) {
    const text = await evaluateStable(collectVisibleText, 4000);
    const decision = askLlm(
      VERIFY_DONE_SYSTEM_PROMPT,
      `Goal: ${goal}\n\nActions already taken: ${JSON.stringify(history)}\n\n` +
        `Current URL: ${page.url()}\n\nCurrent visible page text:\n${text}`
    );
    return !!(decision && decision.met);
  }

  function stepsEqual(a, b) {
    return (
      !!a &&
      !!b &&
      a.selector === b.selector &&
      a.frameSelector === b.frameSelector &&
      a.action === b.action &&
      a.value === b.value
    );
  }

  async function agent(goal, agentOpts = {}) {
    const maxSteps = agentOpts.maxSteps || DEFAULT_MAX_AGENT_STEPS;
    const secrets = agentOpts.secrets;
    const resolvedGoal = substitutePlaceholders(goal, agentOpts.variables);
    const history = [];

    for (let step = 0; step < maxSteps; step++) {
      const elements = await snapshot();
      if (elements.length === 0) {
        throw new Error(
          `browser-ai: no visible interactive elements found for goal "${resolvedGoal}"${await botChallengeHint()}`
        );
      }
      const decision = await decideAction(resolvedGoal, elements, { includeDone: true, history });

      if (decision && decision.done) {
        const shouldVerify = agentOpts.verifyDone !== false;
        if (!shouldVerify || (await verifyGoalMet(resolvedGoal, history))) {
          return { done: true, reason: decision.reason, steps: history };
        }
        // Self-reported "done" didn't hold up against the page's own
        // text - don't trust it, and don't return early. Loop again: a
        // fresh snapshot next iteration may lead the model to a different
        // (correct) decision, still bounded by maxSteps either way.
        console.warn(
          `[browser-ai] agent() reported done ("${decision.reason}") but independent verification ` +
            'disagreed - continuing.'
        );
        continue;
      }

      // Exempt from the stuck-check below: repeating the identical scroll
      // decision several steps in a row is normal, deliberate progress
      // (each call changes the page even though the step itself looks the
      // same), not a loop - unlike re-deriving the same element-targeted
      // action with no apparent effect.
      if (decision && decision.action === 'scroll') {
        const scrollStep = { action: 'scroll', value: decision.value };
        await performScroll(scrollStep);
        const record = { description: `scrolled ${scrollStep.value}`, ...scrollStep };
        history.push(record);
        if (contextEnabled) {
          recordContext({ instruction: resolvedGoal, description: record.description, action: 'scroll' });
        }
        if (agentOpts.onStep) agentOpts.onStep(record, step);
        continue;
      }
      if (!decision || decision.id === undefined || decision.id === null) {
        throw new Error(`browser-ai: agent could not resolve a next step for goal "${resolvedGoal}"`);
      }

      const target = elements[decision.id];
      if (!target) {
        throw new Error(`browser-ai: agent referenced an unknown element for goal "${resolvedGoal}"`);
      }

      // record keeps the placeholder value (if any) - it feeds into the
      // *next* iteration's prompt as "actions already taken", so a real
      // secret must never end up in it, only in the actual browser action.
      const plannedStep = {
        selector: target.selector,
        frameSelector: target.frameSelector,
        action: decision.action,
        value: decision.value,
      };

      const recentHistory = history.slice(-(STUCK_REPEAT_THRESHOLD - 1));
      if (recentHistory.length === STUCK_REPEAT_THRESHOLD - 1 && recentHistory.every((h) => stepsEqual(h, plannedStep))) {
        throw new Error(
          `browser-ai: agent() looks stuck - re-derived the same action (${plannedStep.action} on ` +
            `"${plannedStep.selector}") from a fresh snapshot ${STUCK_REPEAT_THRESHOLD} times in a row for ` +
            `goal "${resolvedGoal}", with no apparent progress. Stopping rather than exhausting maxSteps.`
        );
      }

      await perform({ ...plannedStep, value: substitutePlaceholders(plannedStep.value, secrets) });
      const record = { id: decision.id, description: target.text, ...plannedStep };
      history.push(record);
      if (contextEnabled) {
        recordContext({ instruction: resolvedGoal, description: target.text, action: plannedStep.action });
      }
      if (agentOpts.onStep) agentOpts.onStep(record, step);
    }

    return { done: false, reason: 'max steps reached', steps: history };
  }

  const ai = { act, observe, extract, agent, wait, assert };

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
  'decisionProvider',
  'context',
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
function wrapBrowserLike(target, contextAIOptions = {}) {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'newPage') {
        return async (options) => {
          const { aiOptions, nativeOptions } = splitAIOptions(options);
          const hasNative = Object.keys(nativeOptions).length > 0;
          const page = await (hasNative ? obj.newPage(nativeOptions) : obj.newPage());
          return browserAI(page, { ...contextAIOptions, ...aiOptions });
        };
      }
      if (prop === 'newContext') {
        return async (options) => {
          const { aiOptions, nativeOptions } = splitAIOptions(options);
          const hasNative = Object.keys(nativeOptions).length > 0;
          const context = await (hasNative ? obj.newContext(nativeOptions) : obj.newContext());
          return wrapBrowserLike(context, { ...contextAIOptions, ...aiOptions });
        };
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

// Shared by secrets (substituted into the *value* after the decision, so
// the real value never reaches the LLM/Jev) and variables (substituted
// into the *instruction* before the decision, so the model does see the
// real value - for non-sensitive, dynamic instruction text).
function substitutePlaceholders(text, map) {
  if (typeof text !== 'string' || !map) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : match
  );
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
