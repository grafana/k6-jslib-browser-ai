# k6-browser-ai

A seamless way to drive k6 browser tests with natural-language instructions instead of selectors.

## Installation

k6-browser-ai is available as a [k6 jslib](https://jslib.k6.io). It can be directly
imported as a dependency in your k6 script.

```javascript
import { browser } from "https://jslib.k6.io/k6-browser-ai/0.1.0/index.js";
```

### Requirements

- k6 v2.0.0+
- An Anthropic API key, provided as the `ANTHROPIC_API_KEY` (or `ANTHROPIC_TOKEN`) environment variable.

> **Note:** Each AI call sends some combination of the page's interactive elements, visible text, form-control state,
> and current URL to the configured LLM, depending on the method. Replaying a `Step` through `act()` makes no LLM call, 
> so it sends nothing. Don't use AI calls on pages that show data you aren't comfortable sharing with the LLM provider.

## Quick Start

The following example demonstrates how to use k6-browser-ai in a k6 script.

The module exposes the `browser` object, which is a drop-in replacement for `k6/browser`.
The `newPage()` method returns a page with an additional `ai` namespace that provides AI-driven actions.

```javascript
import { browser } from "https://jslib.k6.io/k6-browser-ai/0.1.0/index.js";

export const options = {
  scenarios: {
    ui: {
      executor: 'shared-iterations',
      options: { browser: { type: 'chromium' } },
    },
  },
};

// The ingredient we want on our pizza. The agent keeps asking QuickPizza for
// recommendations until it gets one containing it, and then the script
// extracts and prints that pizza's name and ingredients.
const yourFavoriteIngredient = 'mushrooms';

export default async function () {
  const page = await browser.newPage();

  try {
    // QuickPizza is our favorite place to order pizza (and a handy playground
    // for testing), so that's where we start our hunt for the perfect one.
    await page.goto('https://quickpizza.grafana.com', { waitUntil: 'networkidle' });

    const agentOutcome = await page.ai.agent(
      'Ask for a pizza until you get one with {{ingredient}}',
      { variables: { ingredient: yourFavoriteIngredient }, maxSteps: 25 },
    );
    const { done, steps } = agentOutcome;
    if (!done) {
      throw new Error(`agent(): failed to get a pizza with ${yourFavoriteIngredient} after ${steps.length} steps`);
    }

    const pizza = await page.ai.extract('The recommended pizza: its name and its ingredients', {
      schema: { name: 'string', ingredients: [] },
    });
    console.log(`🎉 We found a pizza with ${yourFavoriteIngredient}!`);
    console.log(`🍕 Pizza: ${pizza.name}`);
    console.log(`🧾 Ingredients: ${pizza.ingredients.join(', ')}`);
  } finally {
    await page.close();
  }
}
```

Run it with your API key:

```sh
ANTHROPIC_API_KEY=your_key k6 run script.js
```

## Features

### 1. Act on the page

Describe a single action in plain English and k6-browser-ai finds the element and performs it.

```javascript
await page.ai.act('click the sign in button');
```

### 2. Observe and replay

`observe()` returns the matching elements as steps. Pass a step into `act()` to replay it with no LLM call.

```javascript
const links = await page.ai.observe('every nav link');
await page.ai.act(links[0]);
```

### 3. Extract data

Pull structured data out of the page. The `schema` is a hint for the model, not a validated JSON Schema.

```javascript
const user = await page.ai.extract("the user's name", { schema: { name: 'string' } });
```

### 4. Run agents

Give an agent a goal and it takes as many steps as needed (up to `maxSteps`, 10 by default), then re-checks that the goal was met.
It returns `{ done, steps }`, so check `done` before relying on the result.

```javascript
const { done, steps } = await page.ai.agent('dismiss the cookie banner, then open settings', { maxSteps: 5 });
if (!done) {
  throw new Error(`agent didn't finish after ${steps.length} steps`);
}
```

### 5. Wait for conditions

Poll a condition instead of using a hardcoded wait.

```javascript
await page.ai.wait('the page has finished loading and is ready to interact with');
```

### 6. Assert conditions

Check a condition once. It throws if the condition isn't met.

```javascript
await page.ai.assert('the order confirmation is showing');
```

`assert.not` is the inverse: it throws if the condition *is* met.

```javascript
await page.ai.assert.not('an error banner is showing');
```

## Examples

Runnable examples live in `examples/`:

```
ANTHROPIC_API_KEY=your_key k6 run examples/basic.test.js
```

[Here](examples/quickpizza) you can find a couple of examples for our favorite pizza site, QuickPizza 🍕

## API

- `browser` - drop-in for `k6/browser`'s `browser`; `.newPage()` returns an AI-ready page
- `browserAI(page, options?)` - wraps an already-open page directly
- `page.ai.act(instruction | Step, { secrets?, variables? })` - run one action, or replay a `Step` (e.g. from `observe()`) with no LLM call. Can also resolve to a `scroll` (no element needed) when the instruction needs content revealed that isn't on the page yet.
- `page.ai.observe(instruction, { variables? })` - matching elements as `Step[]`, ready to pass into `act()`
- `page.ai.extract(instruction, { schema?, variables? })` - extract structured data
- `page.ai.agent(goal, { maxSteps?, secrets?, variables?, verifyDone? })` - step until done, scrolling to reveal more content when needed. Each step sees the page's visible text and waits for the page to settle after acting. Independently re-checks the goal against that text, and feeds that check's own reasoning back in if it disagrees, so a rejected "done" claim isn't just retried blind.
  - `maxSteps` (number, default 10); `verifyDone` (boolean, default true) - set `false` to skip the independent re-check.
- `page.ai.wait(condition, { timeout?, interval?, variables? })` - poll a condition instead of a hardcoded wait
  - `timeout` (ms, default 10000); `interval` (ms, default 500).
- `page.ai.assert(assertion, { variables? })` - check a condition once; throws if it isn't currently met
- `page.ai.assert.not(assertion, { variables? })` - the inverse of `assert`; throws if the condition is currently met

### Types

These are referenced above and in the examples below, rather than spelled out on every line:

- **`instruction` / `goal` / `condition` / `assertion`** - a plain natural-language string, e.g. `'click the sign in button'`.
- **`Step`** - an element step `{ selector: string, action: 'click'|'fill'|'check'|'uncheck'|'select'|'press', value?: string, frameSelector?: string, description?: string }`, or a scroll step `{ action: 'scroll', value: 'up'|'down' }`. `observe()` returns element steps; `act()` can return either kind. Passing a step into `act()` skips the LLM decision - you're not expected to build one by hand, just pass one straight through.
- **`secrets` / `variables`** - a plain object mapping a `{{name}}` placeholder to its string value, e.g. `{ password: 'actual value' }`. See [Secrets and variables](#secrets-and-variables) below.
- **`schema`** (`extract()` only) - any object shape you want the result to match, e.g. `{ name: 'string' }`. Not real JSON Schema - it's serialized into the prompt as a hint for the model, with no local validation.

### Secrets and variables

`{{name}}` placeholders are resolved as follows:
- `secrets` (`act()` with a string instruction, and `agent()`) - kept as placeholders in the instruction/goal; substituted only into the chosen action's `value` immediately before execution.
- `variables` (all six AI methods) - visible to the LLM; substituted into the instruction/goal/condition/assertion before the LLM call.

Variables, for anything safe to show the model:

```js
await page.ai.act('search for {{query}}', { variables: { query: 'load testing tools' } });
```

`secrets` delays substitution until the browser action, but does not redact later page snapshots:
non-password field values or visible text containing a secret can still be sent to the LLM (password fields are masked).
This option takes an already-resolved string, however you got it, so it works directly with
[`k6/secrets`](https://grafana.com/docs/k6/latest/javascript-api/k6-secrets/)
(or `__ENV`, a `.env` file, anything else):

```js
import secrets from 'k6/secrets';

const password = await secrets.get('password');
await page.ai.act('type {{password}} into the password field', { secrets: { password } });
```

### Options

Passed to `browserAI(page, options)` or `browser.newPage(options)`:

- `llm` (object, optional) - your own client instead of the default Anthropic one. Must implement `.complete(systemPrompt: string, userPrompt: string): string`, called synchronously (not awaited).
- `llmOptions` (object, optional) - options for the *default* client, ignored if you pass your own `llm`:
  - `apiKey` (string) - defaults to the `ANTHROPIC_API_KEY`/`ANTHROPIC_TOKEN` env var or a `.env` file.
  - `model` (string) - defaults to the `BROWSER_AI_MODEL` env var or the library's own default model.
  - `fallbackModel` (string) - Anthropic's safety classifier occasionally refuses a request that has nothing objectionable in it. On a refusal, the library retries once with this model.
- `maxElements` (number, default 150) - cap on interactive elements collected per snapshot; can truncate link-dense pages.
- `actionTimeout` (ms, default 8000) - per-action timeout, passed to k6/browser's own Locator actions (click/fill/check/...).
- `context` (boolean, default false) - feeds a rolling log of past `act()`/`agent()` decisions into every future decision, to help it reason (e.g. "the other checkbox") - never to skip a call.

### Diagnostic logging

Diagnostic logging (the LLM prompt/raw response) goes through `console.debug()`, so it's silent by default - run
`k6 run --verbose your_script.js` (or `--log-level debug`) to see it, same as any other k6 module.

### When `act()` can't find a match

`act()` throws instead of picking an element when nothing on the page plausibly matches the instruction
(e.g., calling `act('click send an email')` on a page with no email UI at all), instead of silently forcing a pick on
whatever scores closest. 

The error includes why:

```
browser-ai: no element on the page satisfies "click send an email": no email-related UI on this page
```

For anything where picking the wrong element would be worse than a clear failure,
compose `observe()` (which can legitimately return `[]`) with `act(step)` (which skips the decision entirely when
given a resolved step) instead of handing the raw instruction straight to `act()`:

```js
const matches = await page.ai.observe('the "send email" button');
if (matches.length === 0) {
  throw new Error('no send-email button on this page');
}
await page.ai.act(matches[0]);
```

## Caveats

- Don't guess when hydration is done; use `wait()` for that.
- Word `wait()` conditions around a concrete fact (e.g., the URL), not a vague state.
- `maxElements` (150 default) can truncate link-dense pages.
- Iframe support: one level deep, same-origin only (for visible text too, not just elements).
- Pages behind bot-detection or CAPTCHA walls can be flaky.
- No shadow-DOM piercing, multi-tab/popup follow, drag-and-drop, or file upload.
- `scroll` (via `act()`/`agent()`) scrolls the window by one viewport, not an inner scrollable container.
- `agent()` reads only the first 4000 characters of visible text, and after each action waits up to 1s for that text to change and settle - an action that changes no text (e.g., checking a box) costs the full wait. If the page text changes while the LLM is deciding, the chosen action is discarded and decided again (once in a row, not counted toward `maxSteps`), at the cost of an extra LLM call.

## License

Apache-2.0
