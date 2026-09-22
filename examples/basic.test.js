import { check } from 'k6';
import { browser } from '../src/browser-ai.js';

export const options = {
  scenarios: {
    ui: {
      executor: 'shared-iterations',
      options: { browser: { type: 'chromium' } },
    },
  },
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export default async function () {
  const page = await browser.newPage({ verbose: true });
  let ok = false;

  try {
    await page.goto('https://test.k6.io/', { waitUntil: 'networkidle' });

    const toggled = await page.ai.agent('make sure the checkbox on the page ends up checked, then stop', {
      maxSteps: 3,
    });
    console.log(`agent(): ${JSON.stringify(toggled)}`);

    const login = await page.ai.find('the login link in the header');
    console.log(`find(): ${JSON.stringify(login)}`);

    await page.ai.do('click the login link in the header');
    await page.waitForLoadState('networkidle');
    console.log(`url after do(): ${page.url()}`);

    const heading = await page.ai.read('what is the page heading/title text?');
    console.log(`read(): ${JSON.stringify(heading)}`);

    ok = true;
  } finally {
    check(null, { 'basic walkthrough completed': () => ok });
    await page.close();
  }
}
