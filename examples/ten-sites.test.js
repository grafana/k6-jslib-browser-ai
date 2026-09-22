import { check } from 'k6';
import { browser } from '../src/browser-ai.js';

export const options = {
  scenarios: {
    ui: { executor: 'shared-iterations', options: { browser: { type: 'chromium' } } },
  },
  // A FAIL still gets logged and the suite keeps running (see run() below),
  // but this makes the k6 process itself exit non-zero when one happens -
  // "FAIL" in the console log used to be purely cosmetic otherwise.
  thresholds: {
    checks: ['rate==1.0'],
  },
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

export default async function () {
  await run('info.cern.ch / read', async (page) => {
    await page.goto('https://info.cern.ch/', { waitUntil: 'networkidle' });
    return page.ai.read('what is the main heading and the first sentence of body text?');
  });

  await run('wikipedia / find+read', async (page) => {
    await page.goto('https://en.wikipedia.org/wiki/Main_Page', { waitUntil: 'networkidle' });
    const search = await page.ai.find('the search input box');
    const title = await page.ai.read('what is the title of the "Today\'s featured article" section?');
    return { search, title };
  });

  await run('hackernews / find+do+read', async (page) => {
    await page.goto('https://news.ycombinator.com/', { waitUntil: 'networkidle' });
    const top = await page.ai.find('the title link of the very first story in the list');
    await page.ai.do('click the "more" link at the bottom of the story list');
    await page.waitForLoadState('networkidle');
    const url = page.url();
    return { top, urlAfterMore: url };
  });

  await run('github / find+read', async (page) => {
    await page.goto('https://github.com/', { waitUntil: 'networkidle' });
    const signIn = await page.ai.find('the sign in link');
    const tagline = await page.ai.read('what is the main marketing headline on this page?');
    return { signIn, tagline };
  });

  await run('the-internet login / do x3 + read', async (page) => {
    await page.goto('https://the-internet.herokuapp.com/login', { waitUntil: 'networkidle' });
    await page.ai.do('type "tomsmith" into the username field');
    await page.ai.do('type "SuperSecretPassword!" into the password field');
    await page.ai.do('click the login button');
    await page.waitForLoadState('networkidle');
    return page.ai.read('what is the success/flash message shown after login?');
  });

  await run('the-internet checkboxes / agent', async (page) => {
    await page.goto('https://the-internet.herokuapp.com/checkboxes', { waitUntil: 'networkidle' });
    return page.ai.agent('make sure both checkboxes on the page end up checked, then stop', {
      maxSteps: 4,
    });
  });

  await run('the-internet dropdown / do+read', async (page) => {
    await page.goto('https://the-internet.herokuapp.com/dropdown', { waitUntil: 'networkidle' });
    await page.ai.do('select "Option 2" from the dropdown');
    return page.ai.read('which option is currently selected in the dropdown?');
  });

  await run('demoqa / find+read', async (page) => {
    await page.goto('https://demoqa.com/', { waitUntil: 'networkidle' });
    const elementsCard = await page.ai.find('the card/box labeled "Elements"');
    const heading = await page.ai.read('what is the site name shown in the top left logo?');
    return { elementsCard, heading };
  });

  await run('saucedemo login / do x3 + read', async (page) => {
    await page.goto('https://www.saucedemo.com/', { waitUntil: 'networkidle' });
    await page.ai.do('type "standard_user" into the username field');
    await page.ai.do('type "secret_sauce" into the password field');
    await page.ai.do('click the login button');
    await page.waitForLoadState('networkidle');
    return page.ai.read('what is the page title/heading shown after logging in?');
  });

  await run('httpbin form / do x3 + read', async (page) => {
    await page.goto('https://httpbin.org/forms/post', { waitUntil: 'networkidle' });
    await page.ai.do('type "Ada Lovelace" into the customer name field');
    await page.ai.do('select medium size for the pizza size option');
    await page.ai.do('click the submit order button');
    await page.waitForLoadState('networkidle');
    return page.ai.read('extract the "custname" and "size" fields from the JSON shown on this page');
  });
}
