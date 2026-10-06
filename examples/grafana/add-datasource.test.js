import { check } from 'k6';
import { browser } from '../../src/browser-ai.js';
import { readEnv } from '../../src/env.js';

export const options = {
  scenarios: { ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } } },
  thresholds: { checks: ['rate==1.0'] },
};

export default async function () {
  const page = await browser.newPage();
  let ok = false;

  try {
    await page.goto(`${readEnv('GRAFANA_URL')}/login`, { waitUntil: 'networkidle' });
    await page.ai.act('type {{user}} into the username field', { secrets: { user: readEnv('ADMIN_USER') } });
    await page.ai.act('type {{password}} into the password field', { secrets: { password: readEnv('ADMIN_PASSWORD') } });
    await page.ai.act('click the log in button');
    // A concrete fact (the URL) is a more reliable wait() condition than
    // a vague state ("logged in") - the page can be genuinely thin on text
    // for a moment right after the redirect.
    await page.ai.wait('the current page URL does not contain "/login"', { timeout: 20000 });

    await page.goto(`${readEnv('GRAFANA_URL')}/connections/datasources/new`, { waitUntil: 'networkidle' });
    await page.locator('input[placeholder="Filter by name or type"]').fill('TestData');
    await page.ai.act('click the TestData data source card/link in the search results');
    await page.ai.wait('the current page URL contains "/connections/datasources/edit/"', { timeout: 10000 });

    await page.ai.act('click the Save and test button');
    await page.ai.wait('the page text contains "Data source is working"', { timeout: 10000 });

    await page.goto(`${readEnv('GRAFANA_URL')}/connections/datasources`, { waitUntil: 'networkidle' });
    const found = await page.ai.observe('a link to the TestData data source in the list');
    console.log(`observe(): ${JSON.stringify(found)}`);
    ok = found.length > 0;
  } finally {
    check(null, { 'TestData data source was added and verified working': () => ok });
    await page.close();
  }
}
