// Paging helpers for WellnessLiving widgets read through Browser Run.
//
// Louisville Community Yoga's workshops widget is an event LIST, five cards
// per page with numbered pagination ("1 2 … 7 ›"). The runner used to read
// only the first page, so everything from page 2 on (a month and more of
// family classes) never reached the review queue, and verification flagged
// live series as "possibly cancelled" because they had moved off page 1
// (found 2026-11-21: 7 pages, only 5 events read).
//
// wlListPagerScript() runs inside the widget page (via addScriptTag): it
// captures each page's text, clicks to the next page, waits for the current
// page number to change, and repeats. Same output contract as
// wlWeekPagerScript in index.js: a PAGER: line, then one "=== PAGE n ==="
// section per page, then a #pr-weeks-done marker for waitForSelector.

// Decides which pagination control to press. Kept as source text so the
// exact same code runs in the page and in tests (the bundler's helpers don't
// exist inside the page, so we can't pass a live function).
// buttons: [{ text, disabled }] in DOM order. The current page is the
// numbered button that is disabled (or aria-current).
export const WL_PICK_NEXT_PAGE_SRC = `function pickNextPage(buttons) {
  var current = null, max = 0, currentAt = -1;
  for (var i = 0; i < buttons.length; i++) {
    var t = String(buttons[i].text || "").trim();
    if (!/^\\d+$/.test(t)) continue;
    var n = Number(t);
    if (n > max) max = n;
    if (buttons[i].disabled) { current = n; currentAt = i; }
  }
  if (current === null) return { done: true, reason: buttons.length ? "no current page marked" : "no pagination" };
  if (current >= max) return { done: true, current: current, max: max };
  for (var j = 0; j < buttons.length; j++) {
    if (String(buttons[j].text || "").trim() === String(current + 1) && !buttons[j].disabled) return { index: j, current: current, max: max };
  }
  // Next number hidden behind an ellipsis: use the arrow after the current page.
  for (var k = buttons.length - 1; k > currentAt; k--) {
    if (!buttons[k].disabled && !/^\\d+$/.test(String(buttons[k].text || "").trim())) return { index: k, current: current, max: max, arrow: true };
  }
  return { done: true, current: current, max: max, reason: "no next-page control" };
}`;

export function wlListPagerScript(maxPages) {
  return `(async function () {
  var MAX = ${Number(maxPages) || 1};
  var deadline = Date.now() + 48000;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var pagesOut = [], notes = [];
  ${WL_PICK_NEXT_PAGE_SRC}
  function controls() {
    var all = document.querySelectorAll("button, a, [role=button]");
    // The LAST visible number-only control: pagination sits under the cards,
    // and a hidden date picker's day buttons must not be mistaken for it.
    var numbered = null;
    for (var i = all.length - 1; i >= 0; i--) {
      if (/^\\d+$/.test((all[i].textContent || "").trim()) && all[i].getClientRects().length) { numbered = all[i]; break; }
    }
    if (!numbered) return { els: [], list: [] };
    var box = numbered.closest("ul, ol, nav") || numbered.parentElement;
    var els = Array.prototype.slice.call(box.querySelectorAll("button, a, [role=button]"));
    return { els: els, list: els.map(function (el) {
      return { text: (el.textContent || "").trim(),
        disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-current") === "page" || el.getAttribute("aria-current") === "true") };
    }) };
  }
  function click(el) {
    ["mousedown", "mouseup", "click"].forEach(function (type) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
  }
  try {
    // Wait for the widget's cards (they load after the page with signed requests).
    while (!/\\d{1,2}:\\d{2}\\s*[ap]m/i.test(document.body.innerText || "") && Date.now() < deadline) await sleep(500);
    for (var p = 0; p < MAX && Date.now() < deadline; p++) {
      await sleep(1500);
      var c = controls();
      var pick = pickNextPage(c.list);
      var label = pick.current ? (pick.current + " of " + pick.max) : String(p + 1);
      pagesOut.push("=== PAGE " + label + " ===\\n" + document.body.innerText);
      if (pick.done) { if (pick.reason && pick.reason !== "no pagination") notes.push(pick.reason); break; }
      if (p === MAX - 1) { notes.push("stopped at the " + MAX + "-page cap of " + pick.max); break; }
      click(c.els[pick.index]);
      var changed = false;
      while (Date.now() < deadline) {
        await sleep(400);
        var after = pickNextPage(controls().list);
        if (after.current && after.current !== pick.current) { changed = true; break; }
      }
      if (!changed) { notes.push("page did not change after clicking past page " + pick.current); break; }
    }
    if (Date.now() >= deadline) notes.push("ran out of time");
  } catch (e) {
    notes.push("error: " + e);
  } finally {
    var pre = document.createElement("pre");
    pre.textContent = "PAGER: captured " + pagesOut.length + " page(s)" + (notes.length ? "; " + notes.join("; ") : "") + "\\n\\n" + pagesOut.join("\\n\\n");
    var done = document.createElement("div");
    done.id = "pr-weeks-done";
    done.textContent = "done";
    document.body.innerHTML = "";
    document.body.appendChild(pre);
    document.body.appendChild(done);
  }
})();`;
}

// Splits paged widget text into one chunk per captured week or page, for the
// fallback extractor (one model call per chunk). Without markers it falls
// back to 12k-character slices.
export const WL_MAX_SECTIONS = 12;
export function wlSections(markdown) {
  const text = String(markdown || "");
  const parts = text.split(/(?==== (?:WEEK|PAGE) \d+)/).filter((p) => /^=== (?:WEEK|PAGE) \d+/.test(p));
  if (parts.length) return parts.slice(0, WL_MAX_SECTIONS);
  const out = [];
  for (let i = 0; i < text.length && out.length < WL_MAX_SECTIONS; i += 12000) out.push(text.slice(i, i + 12000));
  return out;
}
