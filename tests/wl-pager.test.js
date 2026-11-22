// npm test   (node --test tests/*.test.js)
import test from "node:test";
import assert from "node:assert/strict";
import { WL_PICK_NEXT_PAGE_SRC, wlListPagerScript, wlSections, WL_MAX_SECTIONS } from "../src/wl-pager.js";

const pickNextPage = new Function(`${WL_PICK_NEXT_PAGE_SRC}; return pickNextPage;`)();
const b = (text, disabled = false) => ({ text, disabled });

test("page 1 of 7 (Louisville Community Yoga layout): press 2", () => {
  // "1 2 … 7 ›" with 1 disabled, as rendered 2026-11-21
  const r = pickNextPage([b("1", true), b("2"), b("7"), b("")]);
  assert.deepEqual(r, { index: 1, current: 1, max: 7 });
});

test("middle page: press the next number, not the back arrow", () => {
  const r = pickNextPage([b(""), b("1"), b("2", true), b("3"), b("7"), b("")]);
  assert.equal(r.index, 3);
  assert.equal(r.current, 2);
});

test("next number hidden behind an ellipsis: press the forward arrow", () => {
  const r = pickNextPage([b(""), b("1"), b("4", true), b("7"), b("")]);
  assert.deepEqual(r, { index: 4, current: 4, max: 7, arrow: true });
});

test("last page and single page stop", () => {
  assert.equal(pickNextPage([b(""), b("1"), b("6"), b("7", true)]).done, true);
  assert.equal(pickNextPage([b("1", true)]).done, true);
  assert.equal(pickNextPage([]).reason, "no pagination");
});

test("no page marked current stops with a reason instead of looping", () => {
  const r = pickNextPage([b("1"), b("2"), b("3")]);
  assert.equal(r.done, true);
  assert.equal(r.reason, "no current page marked");
});

test("disabled forward arrow on a non-final page reports no next control", () => {
  const r = pickNextPage([b("1"), b("4", true), b("7"), b("", true)]);
  assert.equal(r.done, true);
  assert.equal(r.reason, "no next-page control");
});

test("pager script is valid JavaScript and writes the done marker", () => {
  const src = wlListPagerScript(12);
  assert.doesNotThrow(() => new Function(src));
  assert.match(src, /var MAX = 12;/);
  assert.match(src, /pr-weeks-done/);
  assert.match(src, /=== PAGE /);
});

test("sections split on PAGE and WEEK markers, capped", () => {
  const paged = Array.from({ length: 7 }, (_, i) => `=== PAGE ${i + 1} of 7 ===\nCard ${i + 1}`).join("\n\n");
  const parts = wlSections(`PAGER: captured 7 page(s)\n\n${paged}`);
  assert.equal(parts.length, 7);
  assert.match(parts[6], /^=== PAGE 7 of 7 ===/);
  assert.equal(wlSections("=== WEEK 1: Nov 1 - Nov 7, 2026 ===\na\n=== WEEK 2: Nov 8 - Nov 14, 2026 ===\nb").length, 2);
  const many = Array.from({ length: 20 }, (_, i) => `=== PAGE ${i + 1} ===\nx`).join("\n");
  assert.equal(wlSections(many).length, WL_MAX_SECTIONS);
  assert.equal(wlSections("plain text").length, 1);
});

// Runs the real in-page script against a tiny fake widget: 3 pages of cards
// with "1 2 3 ›" pagination where clicking a number re-renders the list.
test("pager script clicks through every page and captures each", async () => {
  let page = 1;
  const TOTAL = 3;
  const mkBtn = (text, disabled, onClick) => ({
    textContent: text, disabled, getAttribute: () => null, getClientRects: () => [1],
    closest: () => box, dispatchEvent: (e) => { if (e.type === "click" && onClick) onClick(); }
  });
  const buttons = () => [
    ...Array.from({ length: TOTAL }, (_, i) => mkBtn(String(i + 1), page === i + 1, () => { page = i + 1; })),
    mkBtn("", page === TOTAL, () => { if (page < TOTAL) page++; })
  ];
  let current = buttons();
  const box = { querySelectorAll: () => (current = buttons()) };
  let output = "", replaced = false;
  const body = {
    get innerText() { return replaced ? output : `Card on page ${page} 10:30am - 11:30am MT`; },
    set innerHTML(v) { replaced = true; },
    appendChild(el) { if (el.textContent && el.id !== "pr-weeks-done") output += el.textContent; }
  };
  const document = {
    body,
    querySelectorAll: () => (current = buttons()),
    createElement: () => ({})
  };
  class MouseEvent { constructor(type) { this.type = type; } }
  const realSetTimeout = setTimeout;
  const fastTimeout = (fn) => realSetTimeout(fn, 0);
  const run = new Function("document", "window", "MouseEvent", "setTimeout", `return ${wlListPagerScript(12).replace(/;\s*$/, "")};`);
  await run(document, {}, MouseEvent, fastTimeout);
  assert.match(output, /^PAGER: captured 3 page\(s\)\n/);
  assert.match(output, /=== PAGE 1 of 3 ===\nCard on page 1/);
  assert.match(output, /=== PAGE 2 of 3 ===\nCard on page 2/);
  assert.match(output, /=== PAGE 3 of 3 ===\nCard on page 3/);
});
