# k6-browser-ai

A JS library that adds AI-driven actions to k6's `k6/browser` module.

```javascript
// Do actions
await page.ai.do('click the sign in button');

// Extract data
const user = await page.ai.read("the user's name", { schema: { name: 'string' } });
const links = await page.ai.find('every nav link');

// Run agents
await page.ai.agent('dismiss the cookie banner, then open settings');

// Wait for conditions
await page.ai.waitUntil('the page has finished loading and is ready to interact with');
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
- `page.ai.do(instruction | step, { secrets?, variables? })` - run one action, or replay a `find()` result with no LLM call
- `page.ai.find(instruction, { variables? })` - matching elements, ready to pass into `do()`
- `page.ai.read(instruction, { schema?, variables? })` - extract structured data
- `page.ai.agent(goal, { maxSteps?, secrets?, variables?, verifyDone? })` - step until done. Independently re-checks the goal against the page's visible text.
- `page.ai.waitUntil(condition, { timeout?, interval?, variables? })` - poll a condition instead of a hardcoded wait

`{{name}}` pulls from `secrets` (hidden from the LLM) or `variables` (visible to it).

Options: `llm`, `llmOptions`, `jev`, `jevOptions`, `maxElements`, `actionTimeout`, `verbose`, `decisionProvider`, `context`.

`context: true` feeds a rolling log of past `do()`/`agent()` decisions into every future decision, to help it reason (e.g. "the other checkbox") - never to skip a call.

`llmOptions.fallbackModel` - Anthropic's safety classifier occasionally refuses a request. On a refusal, the library retries once with this model.

## Using Jev to make decisions

[TypeSafe's Jev](https://typesafe.ai/) is great at deciding "which element" is best: 
- When`find()` becomes one yes/no question per element.
- When `do()`'s target becomes a choice question. 

To enable it, you can pass `TYPESAFE_API_TOKEN` and enable it in your script:
```js
const page = await browser.newPage({ decisionProvider: 'jev' });
```

## Caveats

- Doesn't guess when hydration is done - use `waitUntil` for that.
- `waitUntil`: word conditions around a fact (the URL), not a vague state.
- `maxElements` (150 default) can truncate link-dense pages.
- Iframe support: one level deep, same-origin only.
- Bot-detection/CAPTCHA walls is a bit flaky.
- No shadow-DOM piercing, multi-tab/popup follow, drag-and-drop, or file upload.

## License

Apache-2.0
