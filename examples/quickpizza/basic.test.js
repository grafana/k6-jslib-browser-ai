import { browser } from '../../src/browser-ai.js';

export const options = {
  scenarios: {
    ui: {
      executor: 'shared-iterations',
      options: { browser: { type: 'chromium' } },
    },
  },
};

export default async function () {
  const page = await browser.newPage({
    report: (e) => console.log(`${e.status === 'passed' ? '✓' : '✗'} ${e.type.padEnd(7)} ${e.instruction}`),
  });

  try {
    // QuickPizza is our favorite place to order pizza (and a handy playground
    // for testing), so that's where we start our hunt for the perfect one.
    await page.goto('https://quickpizza.grafana.com', { waitUntil: 'networkidle' });

    await page.ai.act('Order a pizza');
    await page.ai.wait('Pizza ingredients');
    await page.ai.assert('The listed ingredients include cheese');
  } finally {
    await page.close();
  }
}
