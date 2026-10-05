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
    await page.goto(`${readEnv('GHOST_URL')}/ghost/`, { waitUntil: 'networkidle' });

    // {{email}}/{{password}} are placeholders - the LLM only ever sees
    // these tokens, never the real credentials from .env.
    await page.ai.act('type {{email}} into the email address field', {
      secrets: { email: readEnv('ADMIN_EMAIL') },
    });
    await page.ai.act('type {{password}} into the password field', {
      secrets: { password: readEnv('GHOST_ADMIN_PASSWORD') },
    });
    await page.ai.act('click the sign in button');

    // A concrete fact (the URL) is a more reliable wait() condition
    // than a vague state ("signed in") - the page can be genuinely thin
    // on visible text for a moment right after the redirect.
    await page.ai.wait('the current page URL does not contain "/signin"', { timeout: 20000 });

    const result = await page.ai.extract('what is the title of this site/blog?');
    console.log(`extract(): ${JSON.stringify(result)}`);

    ok = !page.url().includes('/signin');
  } finally {
    check(null, { 'logged into ghost': () => ok });
    await page.close();
  }
}
