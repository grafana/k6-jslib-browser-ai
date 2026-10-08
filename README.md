# k6-browser-ai

A JS library that adds AI-driven actions to k6's `k6/browser` module.

```javascript
// Act
await page.ai.act('click the sign in button');

// Extract data
const user = await page.ai.extract("the user's name", { schema: { name: 'string' } });
const links = await page.ai.observe('every nav link');

// Run agents
await page.ai.agent('dismiss the cookie banner, then open settings');

// Wait for conditions
await page.ai.wait('the page has finished loading and is ready to interact with');

// Assert a condition (throws if not met)
await page.ai.assert('the order confirmation is showing');
```

## Requirements

- k6 v2.0.0+
- An Anthropic API key

## Usage

Runnable examples live in `examples/`:

```
ANTHROPIC_TOKEN=your_token k6 run examples/basic.test.js
```

## API

- `browser` - drop-in for `k6/browser`'s `browser`; `.newPage()` returns an AI-ready page
- `browserAI(page, options?)` - wraps an already-open page directly
- `page.ai.act(instruction | Step, { secrets?, variables? })` - run one action, or replay a `Step` (e.g. from `observe()`) with no LLM call. Can also resolve to a `scroll` (no element needed) when the instruction needs content revealed that isn't on the page yet.
- `page.ai.observe(instruction, { variables? })` - matching elements as `Step[]`, ready to pass into `act()`
- `page.ai.extract(instruction, { schema?, variables? })` - extract structured data
- `page.ai.agent(goal, { maxSteps?, secrets?, variables?, verifyDone? })` - step until done, scrolling to reveal more content when needed. Independently re-checks the goal against the page's visible text.
  - `maxSteps` (number, default 10); `verifyDone` (boolean, default true) - set `false` to skip the independent re-check.
- `page.ai.wait(condition, { timeout?, interval?, variables? })` - poll a condition instead of a hardcoded wait
  - `timeout` (ms, default 10000); `interval` (ms, default 500).
- `page.ai.assert(assertion, { variables? })` - check a condition once; throws if it isn't currently met

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

## Examples

**Looking for something to copy from?** 

[Here](examples/quickpizza) you can find a couple of examples for our favorite pizza site, QuickPizza 🍕

More examples can be found in [examples](examples/).

## Caveats

- Don't guess when hydration is done - use `wait()` for that.
- `wait()`: word conditions around a fact (the URL), not a vague state.
- `maxElements` (150 default) can truncate link-dense pages.
- Iframe support: one level deep, same-origin only.
- Bot-detection/CAPTCHA walls is a bit flaky.
- No shadow-DOM piercing, multi-tab/popup follow, drag-and-drop, or file upload.
- `scroll` (via `act()`/`agent()`) scrolls the window by one viewport, not an inner scrollable container.

## License

Apache-2.0
