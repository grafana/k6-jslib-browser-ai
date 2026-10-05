import { check } from 'k6';
import { browser } from '../src/browser-ai.js';

export const options = {
  scenarios: {
    ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } },
  },
  // No rate==1.0 here: the second half of this list is real top-traffic
  // sites (bot walls, paywalls, geo-dependent cookie banners) that are
  // sometimes *expected* to fail for reasons outside the library's
  // control. The per-site OK/FAIL log is the real signal.
};

async function run(name, fn) {
  const start = Date.now();
  const context = await browser.newContext();
  const page = await context.newPage();
  let ok = false;
  try {
    const result = await fn(page);
    ok = true;
    console.log(`OK   ${name} (${Date.now() - start}ms) :: ${JSON.stringify(result)}`);
  } catch (err) {
    console.log(`FAIL ${name} (${Date.now() - start}ms) :: ${(err && err.message) || String(err)}`);
  } finally {
    check(null, { [name]: () => ok });
    try {
      await context.close();
    } catch (closeErr) {
      console.log(`WARN ${name} :: failed to close context cleanly: ${closeErr.message}`);
    }
  }
}

// Cookie/consent overlays are common enough on real top-traffic sites
// (and geo/session dependent) that every real-world site below calls
// this first. Non-fatal - if it fails because the page is actually a
// bot-challenge wall, not a consent banner, the site's own steps
// surface that more specific error instead.
async function dismissCookies(page) {
  try {
    await page.ai.agent('dismiss any cookie/consent dialog if one is present, then stop', { maxSteps: 2 });
  } catch (err) {
    // not every error k6/browser throws is a real Error with .message
  }
}

export default async function () {
  // --- curated fixtures: simple, static, reliably 100% ---

  await run('info.cern.ch / read', async (page) => {
    await page.goto('https://info.cern.ch/', { waitUntil: 'networkidle' });
    return page.ai.extract('what is the main heading and the first sentence of body text?');
  });

  await run('hackernews / find+do+read', async (page) => {
    await page.goto('https://news.ycombinator.com/', { waitUntil: 'networkidle' });
    const top = await page.ai.observe('the title link of the very first story in the list');
    await page.ai.act('click the "more" link at the bottom of the story list');
    await page.waitForLoadState('networkidle');
    const url = page.url();
    return { top, urlAfterMore: url };
  });

  await run('the-internet login / do x3 + read', async (page) => {
    await page.goto('https://the-internet.herokuapp.com/login', { waitUntil: 'networkidle' });
    await page.ai.act('type "tomsmith" into the username field');
    await page.ai.act('type "SuperSecretPassword!" into the password field');
    await page.ai.act('click the login button');
    await page.waitForLoadState('networkidle');
    return page.ai.extract('what is the success/flash message shown after login?');
  });

  await run('the-internet checkboxes / agent', async (page) => {
    await page.goto('https://the-internet.herokuapp.com/checkboxes', { waitUntil: 'networkidle' });
    return page.ai.agent('make sure both checkboxes on the page end up checked, then stop', {
      maxSteps: 4,
    });
  });

  await run('the-internet dropdown / do+read', async (page) => {
    await page.goto('https://the-internet.herokuapp.com/dropdown', { waitUntil: 'networkidle' });
    await page.ai.act('select "Option 2" from the dropdown');
    return page.ai.extract('which option is currently selected in the dropdown?');
  });

  await run('demoqa / find+read', async (page) => {
    await page.goto('https://demoqa.com/', { waitUntil: 'networkidle' });
    const elementsCard = await page.ai.observe('the card/box labeled "Elements"');
    const heading = await page.ai.extract('what is the site name shown in the top left logo?');
    return { elementsCard, heading };
  });

  await run('saucedemo login / do x3 + read', async (page) => {
    await page.goto('https://www.saucedemo.com/', { waitUntil: 'networkidle' });
    await page.ai.act('type "standard_user" into the username field');
    await page.ai.act('type "secret_sauce" into the password field');
    await page.ai.act('click the login button');
    await page.waitForLoadState('networkidle');
    return page.ai.extract('what is the page title/heading shown after logging in?');
  });

  await run('httpbin form / do x3 + read', async (page) => {
    await page.goto('https://httpbin.org/forms/post', { waitUntil: 'networkidle' });
    await page.ai.act('type "Ada Lovelace" into the customer name field');
    await page.ai.act('select medium size for the pizza size option');
    await page.ai.act('click the submit order button');
    await page.waitForLoadState('networkidle');
    return page.ai.extract('extract the "custname" and "size" fields from the JSON shown on this page');
  });

  // --- real top-traffic sites: heavy SPAs, bot walls, cookie banners ---

  await run('wikipedia.org / find+do+read', async (page) => {
    await page.goto('https://en.wikipedia.org/wiki/Main_Page', { waitUntil: 'load' });
    const search = await page.ai.observe('the search input box');
    await page.ai.act('type "Playwright" into the search box');
    const title = await page.ai.extract('what is the title of "Today\'s featured article"?');
    return { search, title };
  });

  await run('github.com / find+read', async (page) => {
    await page.goto('https://github.com/', { waitUntil: 'load' });
    const signIn = await page.ai.observe('the sign in link');
    const tagline = await page.ai.extract('what is the main marketing headline on this page?');
    return { signIn, tagline };
  });

  await run('youtube.com / do+read', async (page) => {
    await page.goto('https://www.youtube.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    await page.ai.act('type "k6 load testing" into the search box');
    await page.ai.act('press enter to submit the search');
    await page.waitForLoadState('load');
    return page.ai.extract('is a list of video results now showing? give a one-word yes/no');
  });

  await run('stackoverflow.com / do+read', async (page) => {
    await page.goto('https://stackoverflow.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    await page.ai.act('type "async await javascript" into the search box');
    return page.ai.extract('what placeholder or label does the search box show?');
  });

  await run('reddit.com / read', async (page) => {
    await page.goto('https://www.reddit.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    return page.ai.extract('what is the title of the first post shown in the feed?');
  });

  await run('amazon.com / do+read', async (page) => {
    await page.goto('https://www.amazon.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    await page.ai.act('type "wireless mouse" into the search box');
    await page.ai.act('click the search submit button (magnifying glass)');
    await page.waitForLoadState('load');
    return page.ai.extract('did the search return a list of products? give a one-word yes/no');
  });

  await run('google.com / do+read', async (page) => {
    await page.goto('https://www.google.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    await page.ai.act('type "k6 browser testing" into the search box');
    return page.ai.extract('what text is currently in the search box?');
  });

  await run('bing.com / do+read', async (page) => {
    await page.goto('https://www.bing.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    await page.ai.act('type "k6 browser testing" into the search box');
    await page.ai.act('press enter to submit the search');
    await page.waitForLoadState('load');
    return page.ai.extract('did the search return a list of results? give a one-word yes/no');
  });

  await run('linkedin.com / find+read', async (page) => {
    await page.goto('https://www.linkedin.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    const email = await page.ai.observe('the email or phone input field on the sign-in form');
    const heading = await page.ai.extract('what is the main headline shown on this page?');
    return { email, heading };
  });

  await run('x.com / find+read', async (page) => {
    await page.goto('https://x.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    const loginLink = await page.ai.observe('a link or button to sign in / log in');
    const heading = await page.ai.extract('what is the main heading or slogan shown on this page?');
    return { loginLink, heading };
  });

  await run('facebook.com / find+read', async (page) => {
    await page.goto('https://www.facebook.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    const email = await page.ai.observe('the email or phone number input field');
    const heading = await page.ai.extract('what is the main heading shown on this page?');
    return { email, heading };
  });

  await run('instagram.com / read', async (page) => {
    await page.goto('https://www.instagram.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    return page.ai.extract('what is the main heading or tagline shown on this page?');
  });

  await run('netflix.com / find+read', async (page) => {
    await page.goto('https://www.netflix.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    const email = await page.ai.observe('the email address input field');
    const heading = await page.ai.extract('what is the main marketing headline on this page?');
    return { email, heading };
  });

  await run('microsoft.com / find+read', async (page) => {
    await page.goto('https://www.microsoft.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    const search = await page.ai.observe('the search link or icon in the header');
    const heading = await page.ai.extract('what is the main headline on this page?');
    return { search, heading };
  });

  await run('apple.com / find+read', async (page) => {
    await page.goto('https://www.apple.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    const search = await page.ai.observe('the search link or icon in the global nav');
    const heading = await page.ai.extract('what product is being promoted at the top of this page?');
    return { search, heading };
  });

  await run('cnn.com / read', async (page) => {
    await page.goto('https://www.cnn.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    return page.ai.extract('what is the top headline shown on the homepage?');
  });

  await run('bbc.com / find+read', async (page) => {
    await page.goto('https://www.bbc.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    const search = await page.ai.observe('the search icon or link in the header');
    const headline = await page.ai.extract('what is the top news headline shown on this page?');
    return { search, headline };
  });

  await run('nytimes.com / read', async (page) => {
    await page.goto('https://www.nytimes.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    return page.ai.extract('what is the top headline shown on the homepage?');
  });

  await run('imdb.com / do+read', async (page) => {
    await page.goto('https://www.imdb.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    await page.ai.act('type "Inception" into the search box');
    return page.ai.extract('what text is currently in the search box?');
  });

  await run('ebay.com / do+read', async (page) => {
    await page.goto('https://www.ebay.com/', { waitUntil: 'load' });
    await dismissCookies(page);
    await page.ai.act('type "mechanical keyboard" into the search box');
    await page.ai.act('click the search submit button');
    await page.waitForLoadState('load');
    return page.ai.extract('did the search return a list of items? give a one-word yes/no');
  });
}
