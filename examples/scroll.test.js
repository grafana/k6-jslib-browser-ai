import { check } from 'k6';
import { browser } from '../src/browser-ai.js';

export const options = {
  scenarios: {
    ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } },
  },
  thresholds: { checks: ['rate==1.0'] },
};

export default async function () {
  const page = await browser.newPage();
  let ok = false;

  try {
    // quotes.toscrape.com/scroll lazy-loads another batch of quotes each time
    // you scroll near the bottom of the page - a real, stable target for
    // exercising the "scroll" action, since there's genuinely more content to
    // reveal that isn't in the DOM on page load.
    await page.goto('https://quotes.toscrape.com/scroll', { waitUntil: 'networkidle' });

    const seen = new Map();
    const maxScrolls = 10;

    for (let i = 0; seen.size < 20 && i <= maxScrolls; i++) {
      const { quotes } = await page.ai.extract('every quote currently visible on the page, with its text and author', {
        schema: { quotes: [{ text: 'string', author: 'string' }] },
      });
      for (const q of quotes || []) seen.set(q.text, q);
      console.log(`collected so far: ${seen.size}`);
      if (seen.size >= 20 || i === maxScrolls) break;
      await page.ai.act('scroll down to load more quotes');
    }

    const firstTwenty = [...seen.values()].slice(0, 20);
    console.log(JSON.stringify(firstTwenty, null, 2));

    ok = seen.size >= 20;
  } finally {
    check(null, { 'scroll walkthrough completed': () => ok });
    await page.close();
  }
}
