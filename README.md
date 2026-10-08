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
- `page.ai.act(instruction | step, { secrets?, variables? })` - run one action or replay an `observe()` result with no LLM call. Can also resolve to a `scroll` (no element needed) when the instruction needs content revealed that isn't on the page yet.
- `page.ai.observe(instruction, { variables? })` - matching elements, ready to pass into `act()`
- `page.ai.extract(instruction, { schema?, variables? })` - extract structured data
- `page.ai.agent(goal, { maxSteps?, secrets?, variables?, verifyDone? })` - step until done, scrolling to reveal more content when needed. Independently re-checks the goal against the page's visible text.
- `page.ai.wait(condition, { timeout?, interval?, variables? })` - poll a condition instead of a hardcoded wait
- `page.ai.assert(assertion, { variables? })` - check a condition once; throws if it isn't currently met

`{{name}}` pulls from `secrets` (hidden from the LLM) or `variables` (visible to it).

Options: `llm`, `llmOptions`, `maxElements`, `actionTimeout`, `context`.

`context: true` feeds a rolling log of past `act()`/`agent()` decisions into every future decision, to help it reason (e.g. "the other checkbox") - never to skip a call.

Diagnostic logging (the LLM prompt/raw response) goes through `console.debug()`, so it's silent by default - run `k6 run --verbose your_script.js` (or `--log-level debug`) to see it, same as any other k6 module.

`llmOptions.fallbackModel` - Anthropic's safety classifier occasionally refuses a request. On a refusal, the library retries once with this model.

## act() refuses rather than guesses

`act()` throws instead of picking an element when nothing on the page plausibly matches the instruction 
(e.g., calling `act('click send an email')` on a page with no email UI at all), instead of silently forcing a pick on
whatever scores closest. The error includes why:

```
browser-ai: no element on the page satisfies "click send an email": no email-related UI on this page
```

For anything where picking the wrong element would be worse than a clear failure, 
compose `observe()` (which can legitimately return `[]`) with `act(step)`(which skips the decision entirely when 
given a resolved step) instead of handing the raw instruction straight to `act()`:

```js
const matches = await page.ai.observe('the "send email" button');
if (matches.length === 0) {
  throw new Error('no send-email button on this page');
}
await page.ai.act(matches[0]);
```

## Caveats

- Doesn't guess when hydration is done - use `wait()` for that.
- `wait()`: word conditions around a fact (the URL), not a vague state.
- `maxElements` (150 default) can truncate link-dense pages.
- Iframe support: one level deep, same-origin only.
- Bot-detection/CAPTCHA walls is a bit flaky.
- No shadow-DOM piercing, multi-tab/popup follow, drag-and-drop, or file upload.
- `scroll` (via `act()`/`agent()`) scrolls the window by one viewport, not an inner scrollable container.

## License

Apache-2.0
