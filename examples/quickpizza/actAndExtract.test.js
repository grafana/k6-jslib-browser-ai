import { browser } from '../../src/browser-ai.js';

export const options = {
  scenarios: {
    ui: {
      executor: 'shared-iterations',
      options: { browser: { type: 'chromium' } },
    },
  },
};

// The ingredient we want on our pizza. Unlike the agent-driven example, here
// the loop is ours: we ask QuickPizza for a recommendation, extract its
// ingredients, and look for this one in plain code until we find it (or give up).
const yourFavoriteIngredient = 'mushrooms';
const maxAttempts = 25;

export default async function () {
  const page = await browser.newPage();

  try {
    // QuickPizza is our favorite place to order pizza (and a handy playground
    // for testing), so that's where we start our hunt for the perfect one.
    await page.goto('https://quickpizza.grafana.com', { waitUntil: 'networkidle' });

    let previousName = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await page.ai.act('click on "Pizza, Please!"');

      // The click returns before the new recommendation is rendered, so wait
      // for one that differs from the last one we looked at - otherwise we'd
      // read the previous pizza again.
      try {
        await page.ai.wait(
          'a pizza recommendation with its ingredients is shown, and its name is not "{{previous}}"',
          { variables: { previous: previousName }, timeout: 5000 },
        );
      } catch (err) {
        // QuickPizza handed us the same pizza again, which we've already checked.
        continue;
      }

      const pizza = await page.ai.extract('The recommended pizza: its name and its ingredients', {
        schema: { name: 'string', ingredients: [] },
      });
      previousName = pizza.name;

      const hasIngredient = pizza.ingredients.some((ingredient) =>
        ingredient.toLowerCase().includes(yourFavoriteIngredient.toLowerCase()),
      );
      if (hasIngredient) {
        console.log(`🎉 We found a pizza with ${yourFavoriteIngredient}!`);
        console.log(`🍕 Pizza: ${pizza.name}`);
        console.log(`🧾 Ingredients: ${pizza.ingredients.join(', ')}`);
        return;
      }
    }

    throw new Error(`failed to get a pizza with ${yourFavoriteIngredient} after ${maxAttempts} attempts`);
  } finally {
    await page.close();
  }
}
