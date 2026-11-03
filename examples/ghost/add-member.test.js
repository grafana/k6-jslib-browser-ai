import { check } from 'k6';
import { browser } from '../../src/browser-ai.js';

export const options = {
  scenarios: { ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } } },
  thresholds: { checks: ['rate==1.0'] },
};

export default async function () {
  const page = await browser.newPage();
  let ok = false;

  try {
    await page.goto(`${__ENV.GHOST_URL}/ghost/`, { waitUntil: 'networkidle' });
    await page.ai.act('type {{email}} into the email address field', {
      secrets: { email: __ENV.ADMIN_EMAIL },
    });
    await page.ai.act('type {{password}} into the password field', {
      secrets: { password: __ENV.GHOST_ADMIN_PASSWORD },
    });
    await page.ai.act('click the sign in button');
    await page.ai.wait('the current page URL does not contain "/signin"', { timeout: 20000 });

    await page.goto(`${__ENV.GHOST_URL}/ghost/#/members/new`, { waitUntil: 'networkidle' });
    await page.ai.act('type {{name}} into the Name field', { variables: { name: 'K6 Test Member' } });
    await page.ai.act('type {{email}} into the Email field', {
      variables: { email: `k6-browser-ai-${Date.now()}@example.com` },
    });
    await page.ai.act('click the Save button');
    // A new member's URL moves from .../members/new to .../members/<id> -
    // a concrete signal that the save actually went through.
    await page.ai.wait('the current page URL does not contain "/members/new"', { timeout: 10000 });

    await page.goto(`${__ENV.GHOST_URL}/ghost/#/members`, { waitUntil: 'networkidle' });
    // networkidle can resolve before the members table's own data fetch
    // finishes rendering rows - wait for a concrete sign the list is
    // actually populated before searching it.
    await page.ai.wait('the page text contains "K6 Test Member"', { timeout: 10000 });
    const found = await page.ai.observe('a link/row for the member named {{name}}', {
      variables: { name: 'K6 Test Member' },
    });
    console.log(`observe(): ${JSON.stringify(found)}`);
    ok = found.length > 0;
  } finally {
    check(null, { 'member was added and appears in the members list': () => ok });
    await page.close();
  }
}
