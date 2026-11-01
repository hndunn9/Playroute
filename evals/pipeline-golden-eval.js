// Golden-set eval for the scraper review pipeline.
//
// Runs the REAL pre-queue gates from src/pipeline.js (decodeEntities ->
// contentFilter -> validateCandidate) over evals/golden/pipeline-golden.json,
// which holds the owner's own approve/reject decisions. A case is predicted
// "drop" if contentFilter returns a reason or validateCandidate says "error"
// (both stop an item before the review queue). Everything else is "keep".
//
// What the numbers mean:
//   keep accuracy  = approved items the pipeline still lets through (losing
//                    these hides real events, so this should stay at 100%)
//   drop recall    = rejected items the pipeline now catches on its own
//                    (each miss is one more card you reject by hand)
//
// Baseline: evals/golden/baseline.json lists the cases that passed last time
// it was saved. A case that passed before and fails now is a REGRESSION and
// the script exits 1. New passes are reported so you can lock them in.
//
//   node evals/pipeline-golden-eval.js                 # report + regression check
//   node evals/pipeline-golden-eval.js --misses        # also list every miss
//   node evals/pipeline-golden-eval.js --update-baseline
//
// Growing it: when you reject something for a content reason, add a row to
// pipeline-golden.json with expect "drop" (or "keep" for a good event the
// filters got wrong). Re-run, then --update-baseline once a fix lands.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { contentFilter, validateCandidate, decodeEntities } from "../src/pipeline.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "golden", "pipeline-golden.json");
const BASELINE = join(here, "golden", "baseline.json");
const args = new Set(process.argv.slice(2));

const { fields, cases } = JSON.parse(readFileSync(DATA, "utf8"));
const rows = cases.map((c) => Object.fromEntries(fields.map((f, i) => [f, c[i]])));

function predict(row) {
  const ev = { ...row, title: decodeEntities(row.title) };
  // source_url isn't stored in the golden set; it's always present on real
  // candidates, so supply one rather than fail every case on "missing field".
  ev.source_url = "https://example.invalid/";
  const filter = contentFilter(ev);
  if (filter) return { got: "drop", why: `filter:${filter}` };
  const { severity, issues } = validateCandidate(ev, null);
  if (severity === "error") return { got: "drop", why: `invalid:${issues.find((i) => i.level === "error").reason}` };
  return { got: "keep", why: "" };
}

const results = rows.map((r) => ({ ...r, ...predict(r) }));
results.forEach((r) => { r.pass = r.got === r.expect; });

// Per-source table.
const bySource = new Map();
for (const r of results) {
  const s = bySource.get(r.source_key) || { keep: 0, keepOk: 0, drop: 0, dropOk: 0 };
  if (r.expect === "keep") { s.keep++; if (r.pass) s.keepOk++; } else { s.drop++; if (r.pass) s.dropOk++; }
  bySource.set(r.source_key, s);
}
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%`.padStart(4) : "   –");
console.log("\nsource                       keep ok      drop caught");
let K = 0, KO = 0, D = 0, DO = 0;
for (const [src, s] of [...bySource].sort()) {
  K += s.keep; KO += s.keepOk; D += s.drop; DO += s.dropOk;
  console.log(`${src.padEnd(28)} ${String(s.keepOk).padStart(3)}/${String(s.keep).padEnd(3)} ${pct(s.keepOk, s.keep)}   ${String(s.dropOk).padStart(3)}/${String(s.drop).padEnd(3)} ${pct(s.dropOk, s.drop)}`);
}
console.log(`${"ALL".padEnd(28)} ${String(KO).padStart(3)}/${String(K).padEnd(3)} ${pct(KO, K)}   ${String(DO).padStart(3)}/${String(D).padEnd(3)} ${pct(DO, D)}`);

// Weighted by how many times you actually reviewed each title.
const w = (pred) => results.filter(pred).reduce((a, r) => a + (r.n || 1), 0);
console.log(`\nBy review volume: ${w((r) => r.expect === "drop" && r.pass)} of ${w((r) => r.expect === "drop")} rejections would be auto-dropped; ${w((r) => r.expect === "keep" && !r.pass)} approvals would be wrongly dropped.`);

const wrongDrops = results.filter((r) => r.expect === "keep" && !r.pass);
if (wrongDrops.length) {
  console.log("\nGood events the pipeline would DROP (fix these first):");
  for (const r of wrongDrops) console.log(`  #${r.pending_id} [${r.source_key}] ${r.title} -> ${r.why}`);
}
if (args.has("--misses")) {
  console.log("\nRejected items that still reach review:");
  for (const r of results.filter((x) => x.expect === "drop" && !x.pass)) {
    console.log(`  #${r.pending_id} [${r.source_key}] (${r.reason}, ×${r.n}) ${r.title.slice(0, 90)}`);
  }
}

// Baseline regression gate.
const passing = results.filter((r) => r.pass).map((r) => r.pending_id).sort((a, b) => a - b);
if (args.has("--update-baseline")) {
  writeFileSync(BASELINE, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), passing }, null, 0) + "\n");
  console.log(`\nBaseline saved: ${passing.length}/${results.length} passing.`);
  process.exit(0);
}
let base = null;
try { base = JSON.parse(readFileSync(BASELINE, "utf8")); } catch { /* first run */ }
if (!base) {
  console.log("\nNo baseline yet. Run with --update-baseline to save one.");
  process.exit(0);
}
const now = new Set(passing);
const regressions = base.passing.filter((id) => !now.has(id));
const newPasses = passing.filter((id) => !base.passing.includes(id));
if (newPasses.length) console.log(`\n${newPasses.length} case(s) newly passing: ${newPasses.join(", ")}. Run --update-baseline to lock them in.`);
if (regressions.length) {
  console.log(`\nREGRESSION: ${regressions.length} case(s) passed in the baseline and fail now:`);
  for (const id of regressions) {
    const r = results.find((x) => x.pending_id === id);
    console.log(`  #${id} [${r.source_key}] expected ${r.expect}, got ${r.got} ${r.why} — ${r.title.slice(0, 80)}`);
  }
  process.exit(1);
}
console.log("\nNo regressions against baseline.");
