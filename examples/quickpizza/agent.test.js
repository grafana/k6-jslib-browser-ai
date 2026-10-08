import { browser } from '../../src/browser-ai.js';

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
