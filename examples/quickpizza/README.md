# 🍕 QuickPizza examples

Two ways to solve the same problem on [QuickPizza](https://quickpizza.grafana.com):

> **Keep asking for a pizza until we get one with our favorite ingredient** 🍄

Both scripts end the same way:

```
🎉 We found a pizza with mushrooms!
🍕 Pizza: The Solid Siciliana
🧾 Ingredients: Olive oil, Roma tomatoes, Mozzarella, Mushrooms
```

## The two flavors

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

## 🚀 Run them

```sh
ANTHROPIC_TOKEN=... k6 run examples/quickpizza/agent.test.js
ANTHROPIC_TOKEN=... k6 run examples/quickpizza/actAndExtract.test.js
```

Change `yourFavoriteIngredient` at the top of each script to hunt for something else. 🧀

## 🤔 Which one should I use?

- **Agent** → quick to write, great when the steps aren't fixed.
- **Act & extract** → when you want predictable, debuggable, step-by-step control.
