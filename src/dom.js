// Runs inside the browser page (via page.evaluate) to build a compact map of
// visible interactive elements. Must stay self-contained: no closures over
// outer scope, since it is serialized and executed in the browser context.
function collectInteractiveElements(maxElements) {
  const SELECTOR =
    'a, button, input, select, textarea, [role], [contenteditable="true"], [onclick], summary';

  // Frameworks routinely make a plain <li>/<div>/<span> clickable via a
  // JS-only event listener, with no `role` or `onclick` attribute to mark
  // it up as such - invisible to SELECTOR above even though it's clearly
  // meant to be clicked. `cursor: pointer` is the one signal frameworks
  // still reliably set for these, so it's used as a fallback net in
  // collectFrom() below (verified: Grafana's time-range quick-range rows
  // - "Last 24 hours" etc. - are exactly this: bare <li> elements the
  // main selector couldn't see at all, collapsing the whole list into one
  // unusable blob of concatenated text via its <ul role="presentation">
  // ancestor, which *does* match on [role]).
  function hasPointerCursor(el) {
    return el.ownerDocument.defaultView.getComputedStyle(el).cursor === 'pointer';
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    // Use the element's own document's window, not the outer frame's -
    // matters once this walks into a same-origin iframe's document below.
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  // Disabled controls can't meaningfully be acted on - excluding them from
  // the candidate set entirely means neither the LLM nor Jev can ever pick
  // one, and there's no "should we force-click a disabled thing" question
  // to answer downstream. `.disabled` covers native controls (and ones
  // disabled via a disabled <fieldset>); aria-disabled covers everything
  // else (e.g. an <a> or a custom [role="button"]).
  function isDisabled(el) {
    return !!el.disabled || el.getAttribute('aria-disabled') === 'true';
  }

  // A field with no innerText/value/aria-label/placeholder can still have
  // a real, correct label - an explicit <label for="id"> or an ancestor
  // <label> wrapping the field entirely - which is the standard, valid way
  // to label a form field and not specific to any one site.
  function labelText(el) {
    if (el.id) {
      const byFor = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor) return byFor.textContent.trim();
    }
    const ancestor = el.closest('label');
    return ancestor ? ancestor.textContent.trim() : '';
  }

  // An icon-only element (a magnifying-glass <svg> submit button, a
  // decorative-looking nav toggle) routinely has no innerText, value,
  // aria-label or placeholder at all - verified this session on eBay's
  // search-submit icon and x.com's social-login icons, both of which
  // ended up as blank candidates the model had to guess at with zero
  // information. These two are lower-confidence than the direct ARIA
  // sources above, so they're only tried as a last resort, but they're
  // still real, deliberately-authored accessible-name-adjacent signals,
  // not guesses: an SVG's own <title> child is the standard way to give
  // an inline icon an accessible name, and a data-testid/data-test value
  // is near-universally written to be human-readable QA/test tooling by
  // the site's own authors ("data-testid Save dashboard button") - this
  // reuses that same attribute dom.js already reads for selector
  // shortcuts, just as descriptive text instead.
  function svgTitleText(el) {
    if (el.tagName.toLowerCase() !== 'svg') return '';
    const titleEl = el.querySelector('title');
    return titleEl ? titleEl.textContent.trim() : '';
  }

  function testIdText(el) {
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
    return testId ? testId.replace(/[-_]+/g, ' ').trim() : '';
  }

  function cssPath(el) {
    // id and data-testid are common shortcuts, but neither is guaranteed
    // unique in practice (e.g. Grafana reuses the same data-testid across
    // every nav menu item) - a non-unique selector makes Playwright's
    // strict-mode locator throw instead of acting, so verify before using
    // either shortcut rather than assuming.
    const doc = el.ownerDocument;
    if (el.id) {
      const idSelector = `#${CSS.escape(el.id)}`;
      if (doc.querySelectorAll(idSelector).length === 1) return idSelector;
    }
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const testIdSelector = `[data-testid="${testId}"]`;
      if (doc.querySelectorAll(testIdSelector).length === 1) return testIdSelector;
    }

    const parts = [];
    let node = el;
    let path = '';
    while (node && node.nodeType === 1) {
      let part = node.tagName.toLowerCase();
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(
          (n) => n.tagName === node.tagName
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      path = parts.join(' > ');
      // 6 levels is comfortably enough to disambiguate ordinary markup, but
      // a deeply-nested modern SPA (custom elements, heavily wrapped
      // component trees - verified on youtube.com and facebook.com) can
      // produce an identical 6-level suffix for two unrelated elements.
      // That silently breaks every action on it, not just this one, since
      // Playwright's strict-mode locator throws "multiple elements
      // returned" instead of acting - so verify past that point rather
      // than assume, climbing all the way to the document root if we have
      // to, until the selector actually resolves to just this element.
      if (parts.length >= 6 && doc.querySelectorAll(path).length === 1) return path;
      node = node.parentElement;
    }
    return path;
  }

  const results = [];
  let truncated = false;

  // frameSelector is the top-document CSS selector of the <iframe> this
  // doc lives in (page.frameLocator() needs exactly that), or undefined
  // for the top-level document itself.
  function collectFrom(doc, frameSelector) {
    if (truncated) return;
    const matched = Array.from(doc.querySelectorAll(SELECTOR));
    const matchedSet = new Set(matched);

    // Second pass for the cursor:pointer fallback (see hasPointerCursor
    // above) - keep only the outermost pointer-cursor element in each
    // nested cluster (e.g. an <li> wrapping an icon <span> that also
    // inherits cursor:pointer), since a click anywhere inside it reaches
    // the same handler and the outer element's own text already captures
    // the whole row.
    const pointerSet = new Set();
    for (const el of doc.querySelectorAll('*')) {
      // <label> gets a default cursor:pointer from the browser's own UA
      // stylesheet whenever it wraps/targets a form control, which would
      // otherwise add it here as a second, redundant candidate right next
      // to the control it labels - labelText() above already folds a
      // label's text into its target field instead.
      if (matchedSet.has(el) || el.tagName === 'LABEL' || !hasPointerCursor(el)) continue;
      // Also covered if an ancestor already matched the *native* selector
      // (e.g. this is a <span> inside an <a>, inheriting cursor:pointer
      // from it) - not just an ancestor claimed by this same pass -
      // otherwise an icon/text wrapper inside an already-interactive
      // element ends up as a second, redundant candidate right next to
      // its own parent (verified: github.com's "Sign in" <a> and its
      // inner <span> both showing up separately).
      let covered = false;
      for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (pointerSet.has(ancestor) || matchedSet.has(ancestor)) {
          covered = true;
          break;
        }
      }
      if (!covered) pointerSet.add(el);
    }

    const nodes = matched.concat(Array.from(pointerSet));

    for (const el of nodes) {
      if (!isVisible(el) || isDisabled(el)) continue;
      if (results.length >= maxElements) {
        truncated = true;
        return;
      }

      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') || undefined;

      // A <select>'s innerText is the browser-concatenated text of *every*
      // option, not the selected one - use the actually-selected option's
      // label instead, so callers (do()/find()/read()) see real state.
      // A password field's current value must never be sent to an LLM,
      // regardless of how it got typed in (page.ai.do(), a plain
      // page.locator().fill(), or the user) - describe it, don't echo it.
      let text;
      if (type === 'password') {
        text = '(password field)';
      } else if (tag === 'select') {
        const selected = el.options[el.selectedIndex];
        text = selected ? selected.label || selected.text || selected.value || '' : '';
      } else {
        text = (
          el.innerText ||
          el.value ||
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.getAttribute('placeholder') ||
          labelText(el) ||
          svgTitleText(el) ||
          testIdText(el) ||
          ''
        );
      }
      text = text.trim().slice(0, 120);

      const entry = {
        id: results.length,
        tag,
        type,
        role: el.getAttribute('role') || undefined,
        text,
        selector: cssPath(el),
      };

      if (frameSelector) entry.frameSelector = frameSelector;
      if (tag === 'select') {
        entry.options = Array.from(el.options).map((o) => o.label || o.text || o.value);
      }
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        entry.checked = el.checked;
      }

      results.push(entry);
    }

    // Descend into same-origin iframes, one level deep (a frame nested
    // inside a frame is rare enough not to be worth the extra complexity
    // of chained frameLocator() selectors). Cross-origin iframes throw or
    // return null on contentDocument access - there's genuinely no way to
    // see inside them from here, but silently dropping them gives the
    // model zero signal that reachable-looking content exists there at
    // all (e.g. an embedded payment form or widget) - a non-actionable
    // hint entry is strictly more honest than nothing, same spirit as
    // botChallengeHint() elsewhere in this library.
    if (!frameSelector) {
      const iframes = Array.from(doc.querySelectorAll('iframe'));
      for (const frame of iframes) {
        if (truncated) return;
        let innerDoc = null;
        try {
          innerDoc = frame.contentDocument;
        } catch (err) {
          innerDoc = null;
        }
        if (innerDoc) {
          collectFrom(innerDoc, cssPath(frame));
          continue;
        }
        if (!isVisible(frame) || results.length >= maxElements) continue;
        results.push({
          id: results.length,
          tag: 'iframe',
          text: '(cross-origin embedded content - not inspectable by browser-ai)',
          selector: cssPath(frame),
        });
      }
    }
  }

  collectFrom(document, undefined);
  return { elements: results, truncated };
}

// Runs inside the browser page (via page.evaluate) for read()/waitUntil():
// document.body.innerText sends the *entire* page's text to the LLM,
// including offscreen article bodies, footers, and nav menus that have
// nothing to do with whatever's actually on screen right now - wasted
// tokens and cost at best, and at worst noise that can tip a request into
// looking like something it isn't (verified: x.com's footer legal links
// riding along in a read() prompt contributed to an Anthropic safety
// refusal that a shorter, on-screen-only prompt didn't trigger). Prunes
// whole offscreen subtrees rather than walking every text node, so a
// large "reasonably sized" visible section still gets its own innerText
// wholesale - keeping that method's natural line-break handling - while a
// wrapper far taller than the viewport (<body>, a long <article>) gets
// recursed into instead of taken as one giant blob.
function collectVisibleText(maxChars) {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function inViewportRect(rect) {
    return rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
  }

  function reasonablySized(rect) {
    return rect.height <= vh * 1.5 && rect.width <= vw * 1.5;
  }

  function walk(el) {
    if (SKIP_TAGS.has(el.tagName)) return [];
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return [];

    const rect = el.getBoundingClientRect();
    // A real box (nonzero size) tells us where the element actually is,
    // so an offscreen one can be pruned with confidence, and a reasonably
    // sized on-screen one can be taken via innerText wholesale. A zero-size
    // box (a `display: contents` layout wrapper, or any element with no
    // rendered box of its own) tells us nothing either way - its children
    // still have their own real boxes, so fall through to recursing into
    // them rather than assuming "no box" means "not visible" (verified
    // regression: bbc.com's story-card wrappers are `display: contents`,
    // and treating their zero rect as offscreen silently dropped the
    // actual headline text from every read()/waitUntil() call).
    const hasBox = rect.width > 0 || rect.height > 0;
    if (hasBox) {
      if (!inViewportRect(rect)) return [];
      if (reasonablySized(rect) || el.children.length === 0) {
        const text = (el.innerText || '').trim();
        return text ? [text] : [];
      }
    }
    const parts = [];
    for (const child of el.children) parts.push(...walk(child));
    return parts;
  }

  return walk(document.body).join('\n\n').slice(0, maxChars);
}

export { collectInteractiveElements, collectVisibleText };
