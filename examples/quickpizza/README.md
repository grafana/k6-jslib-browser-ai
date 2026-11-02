# 🍕 QuickPizza examples

Examples on [QuickPizza](https://quickpizza.grafana.com), starting with the basics and then going further:

1. [The basics](#-the-basics): `act`, `wait` and `assert` in a few lines.
2. [Same problem, two approaches](#-same-problem-two-approaches): let the AI drive, or drive it yourself.

## 🌱 The basics

`basic.test.js` orders one pizza and checks that it has cheese:

```js
await page.ai.act('Order a pizza');                                // do something
await page.ai.wait('Pizza ingredients');                           // wait for it
await page.ai.assert('The listed ingredients include cheese');     // check it
```

Reports are off by default. To see how each step went, pass a `report` function to `browser.newPage()`. It's called as each `page.ai` call finishes:

```js
const page = await browser.newPage({
  report: (e) => console.log(`${e.status === 'passed' ? '✓' : '✗'} ${e.type.padEnd(7)} ${e.instruction}`),
});
```

```
✓ act     Order a pizza
✓ wait    Pizza ingredients
✓ assert  The listed ingredients include cheese
```

Or use `report: 'json'` to log one `browser-ai:step {json}` line per call.

QuickPizza picks pizzas at random, so the `assert` fails whenever the pizza has no cheese. 🧀

## 🍄 Same problem, two approaches

> **Keep asking for a pizza until we get one with our favorite ingredient**

Both scripts end the same way:

```
🎉 We found a pizza with mushrooms!
🍕 Pizza: The Solid Siciliana
🧾 Ingredients: Olive oil, Roma tomatoes, Mozzarella, Mushrooms
```

|                      | 🤖 `agent.test.js`                     | 🛠️ `actAndExtract.test.js`                |
|----------------------|----------------------------------------|-------------------------------------------|
| **Who drives?**      | The AI                                 | Your code                                 |
| **Main call**        | `ai.agent(goal)`                       | `ai.act()` → `ai.wait()` → `ai.extract()` |
| **The loop**         | Inside the agent                       | A plain `for` loop                        |
| **"Has mushrooms?"** | Decided by the AI (and double-checked) | `ingredients.some(...)`, plain JavaScript |
| **Script size**      | Tiny                                   | A bit longer                              |
| **Predictability**   | Flexible, can adapt to surprises       | You control every step                    |
| **LLM calls**        | Fewer                                  | ~3 per pizza                              |

### 🤖 Agent

Give it a goal in plain English and let it figure out the clicks:

```js
await page.ai.agent('Ask for a pizza until you get one with {{ingredient}}', { maxSteps: 25 });
```

### 🛠️ Act & extract

You write the loop, the AI only handles the page:

```js
for (...) {
  await page.ai.act('click on "Pizza, Please!"');   // click
  await page.ai.wait('a new recommendation is shown'); // wait for it
  const pizza = await page.ai.extract('name and ingredients'); // read it
  if (pizza.ingredients.some(...)) break;            // you decide
}
```

### 🤔 Which one should I use?

- **Agent** → quick to write, great when the steps aren't fixed.
- **Act & extract** → when you want predictable, debuggable, step-by-step control.

## 🚀 Run them

```sh
ANTHROPIC_TOKEN=... k6 run examples/quickpizza/basic.test.js
ANTHROPIC_TOKEN=... k6 run examples/quickpizza/agent.test.js
ANTHROPIC_TOKEN=... k6 run examples/quickpizza/actAndExtract.test.js
```

Change `yourFavoriteIngredient` at the top of the last two scripts to hunt for something else. 🧀
