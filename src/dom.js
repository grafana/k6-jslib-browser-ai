// Runs inside the browser page (via page.evaluate) to build a compact map of
// visible interactive elements. Must stay self-contained: no closures over
// outer scope, since it is serialized and executed in the browser context.
function collectInteractiveElements(maxElements) {
  const SELECTOR =
    'a, button, input, select, textarea, [role], [contenteditable="true"], [onclick], summary';

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

  function cssPath(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid');
    if (testId) return `[data-testid="${testId}"]`;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
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
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const results = [];
  let truncated = false;

  // frameSelector is the top-document CSS selector of the <iframe> this
  // doc lives in (page.frameLocator() needs exactly that), or undefined
  // for the top-level document itself.
  function collectFrom(doc, frameSelector) {
    if (truncated) return;
    const nodes = Array.from(doc.querySelectorAll(SELECTOR));

    for (const el of nodes) {
      if (!isVisible(el) || isDisabled(el)) continue;
      if (results.length >= maxElements) {
        truncated = true;
        return;
      }

      const tag = el.tagName.toLowerCase();

      // A <select>'s innerText is the browser-concatenated text of *every*
      // option, not the selected one - use the actually-selected option's
      // label instead, so callers (do()/find()/read()) see real state.
      let text;
      if (tag === 'select') {
        const selected = el.options[el.selectedIndex];
        text = selected ? selected.label || selected.text || selected.value || '' : '';
      } else {
        text = (
          el.innerText ||
          el.value ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          ''
        );
      }
      text = text.trim().slice(0, 120);

      const type = el.getAttribute('type') || undefined;
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
    // return null on contentDocument access - just skip those; there is
    // no way to see inside them from here regardless.
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
        if (!innerDoc) continue;
        collectFrom(innerDoc, cssPath(frame));
      }
    }
  }

  collectFrom(document, undefined);
  return { elements: results, truncated };
}

export { collectInteractiveElements };
