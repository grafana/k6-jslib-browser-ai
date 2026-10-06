import { check } from 'k6';
import { browser } from '../../src/browser-ai.js';
import { readEnv } from '../../src/env.js';

export const options = {
  scenarios: { ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } } },
  thresholds: { checks: ['rate==1.0'] },
};

// A deeper stress test than login.test.js/add-datasource.test.js: creating
// and configuring a dashboard exercises Grafana's custom React widgets -
// a visualization picker with search-and-select suggestion cards, a save
// drawer, a time-range popover with quick-range buttons - none of which
// are plain native <select>/<input> elements. Every wait below is a
// page.ai.wait() grounded in a concrete textual fact ("this phrase is
// on the page"), never a vague visual/spatial claim like "a drawer is
// open on the right" - wait() only ever sees text + URL, so it can't
// verify layout at all (see README Caveats).
export default async function () {
  const page = await browser.newPage();
  let ok = false;

  try {
    await page.goto(`${readEnv('GRAFANA_URL')}/login`, { waitUntil: 'networkidle' });
    await page.ai.act('type {{user}} into the username field', { secrets: { user: readEnv('ADMIN_USER') } });
    await page.ai.act('type {{password}} into the password field', { secrets: { password: readEnv('ADMIN_PASSWORD') } });
    await page.ai.act('click the log in button');
    await page.ai.wait('the current page URL does not contain "/login"', { timeout: 20000 });

    await page.goto(`${readEnv('GRAFANA_URL')}/dashboard/new`, { waitUntil: 'networkidle' });
    await page.ai.wait('the page text contains the phrase "Drag or click to add a panel"', { timeout: 8000 });

    await page.ai.act('click the panel drag-or-click area to add a panel');
    await page.ai.wait('the page text contains both "Configure visualization" and "Transparent background"', {
      timeout: 8000,
    });

    await page.ai.act('clear the panel title field and type "browser-ai test panel" into it');
    await page.ai.act('click the "Configure visualization" button');
    await page.ai.wait('the page text contains both "Suggestions" and "All visualizations"', { timeout: 8000 });

    await page.ai.act('type "Bar chart" into the visualization search box on the right panel');
    await page.ai.wait('the page text contains the phrase "Bar chart"', { timeout: 8000 });
    await page.ai.act('click the Bar chart visualization suggestion card');
    await page.ai.wait(
      'the page text contains "Bar chart" immediately followed by the word "Change" (the current-visualization-type header, not just a suggestion in a list)',
      { timeout: 8000 }
    );

    await page.ai.act('click the "Back" button to return to the dashboard');
    await page.ai.wait(
      'the page text contains "browser-ai test panel" but does not contain "Configure visualization"',
      { timeout: 8000 }
    );

    await page.ai.act('click the "Save" button');
    await page.ai.wait(
      'the page text contains a "Dashboard name" or "Title" field label together with a "Save" button',
      { timeout: 8000 }
    );
    await page.ai.act('type "browser-ai journey dashboard" into the dashboard title field');
    await page.ai.act('click the "Save" button in the dialog to confirm saving the dashboard');
    await page.ai.wait('the page text no longer contains "Dashboard name" (the save dialog has closed)', {
      timeout: 8000,
    });

    await page.ai.act('click the time range picker button (currently showing "Last 6 hours")');
    await page.ai.wait('the page text contains both "Apply time range" and "Last 5 minutes"', { timeout: 8000 });
    await page.ai.act('click the "Last 24 hours" quick range option');
    await page.ai.wait('the page text contains "Last 24 hours" but no longer contains "Apply time range"', {
      timeout: 8000,
    });

    ok = true;
  } finally {
    check(null, { 'created and configured a dashboard end to end': () => ok });
    await page.close();
  }
}
