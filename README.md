# k6-browser-ai

A JS library that adds AI-driven actions to k6's `k6/browser` module. 

```javascript
// Act
await page.ai.do('click the sign in button');

// Extract (optionally with a schema)
const user = await page.ai.read('the user\'s name', { schema: { name: 'string' } });
const links = await page.ai.find('every nav link');

// Run agents
await page.ai.agent('dismiss the cookie banner, then open settings');
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
- `page.ai.do(instruction | step)` - run one action, or replay a `find()` result with no LLM call
- `page.ai.find(instruction)` - matching elements, ready to pass into `do()`
- `page.ai.read(instruction, { schema? })` - extract structured data
- `page.ai.agent(goal, { maxSteps? })` - step until done

Options: `llm`, `llmOptions`, `jev`, `jevOptions`, `maxElements`,
`actionTimeout`, `verbose`, `decisionProvider` (default `'llm'`).

## Using Jev to make decisions

[TypeSafe's Jev](https://typesafe.ai/) is *great** at deciding "which element" is best: 
- When`find()` becomes one yes/no question per element.
- When `do()`'s target becomes a choice question. 

To enable it, you can pass `TYPESAFE_API_TOKEN` and enable it in your script:
```js
const page = await browser.newPage({ decisionProvider: 'jev' });
```

<small>Measured on `find()` against Wikipedia, 5 runs each: **~510ms with Jev vs ~1483ms with Anthropic**</small>

## Caveats

- You need to wait for the page to settle, it doesn't guess when hydration is done.
- `maxElements` defaults to 150 can truncate on link-dense pages.
- Iframe support goes one level deep and same-origin only.

## License

Apache-2.0
