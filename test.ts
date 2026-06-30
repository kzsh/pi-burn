/**
 * Standalone visual tests for pi-burn rendering logic.
 * No pi dependency — runs directly with: bun test.ts
 *
 * Prints the graph and status line for each scenario so you can eyeball them.
 */

import {
  DEFAULT_BUDGET,
  buildDetailReport,
  buildStatusParts,
  formatCost,
  renderCostGraph,
  type RequestRecord,
  type StatusStyle,
} from "./lib.ts";

// Splits a record's total cost across token types using Anthropic-style pricing
// weights (output costs ~5x input, cacheWrite ~1.25x, cacheRead ~0.1x).
// Used to generate realistic per-type cost fields for test fixtures.
function withCostSplit(r: Omit<RequestRecord, 'inputCost'|'outputCost'|'cacheReadCost'|'cacheWriteCost'>): RequestRecord {
  const INPUT_W = 1, OUTPUT_W = 5, CW_W = 1.25, CR_W = 0.1;
  const denom =
    r.inputTokens * INPUT_W +
    r.outputTokens * OUTPUT_W +
    r.cacheWriteTokens * CW_W +
    r.cacheHitTokens * CR_W;
  if (denom === 0) return { ...r, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0 };
  const u = r.cost / denom;
  return {
    ...r,
    inputCost:      u * r.inputTokens * INPUT_W,
    outputCost:     u * r.outputTokens * OUTPUT_W,
    cacheWriteCost: u * r.cacheWriteTokens * CW_W,
    cacheReadCost:  u * r.cacheHitTokens * CR_W,
  };
}

// ── Simple ANSI helpers for the test output ───────────────────────────────────
// These approximate what pi's theme.fg() does for each StatusStyle.

const RESET = "\x1b[0m";

const STYLE_ANSI: Record<StatusStyle, string> = {
  dim:     "\x1b[2m",
  muted:   "\x1b[90m",
  warning: "\x1b[33m",
  success: "\x1b[32m",
};

function renderStatus(records: RequestRecord[]): string {
  const parts = buildStatusParts(records);
  return parts.map(p => STYLE_ANSI[p.style] + p.text + RESET).join("  ");
}

// Helper to render the two-row graph as a block for show().
function graph(
  records: RequestRecord[],
  liveRecord: RequestRecord | null = null,
  width = 40,
): string {
  const lines = renderCostGraph(records, liveRecord, width);
  return lines.join("\n") || "(empty)";
}

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function section(title: string) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n${"─".repeat(title.length)}\n`);
}

function show(label: string, content: string) {
  const lines = content.split("\n");
  const pad   = label.padEnd(38);
  process.stdout.write(`  ${pad} ${lines[0] ?? ""}\n`);
  for (const l of lines.slice(1)) {
    process.stdout.write(`  ${" ".repeat(38)} ${l}\n`);
  }
}

function check(label: string, actual: string, expected: string) {
  if (actual === expected) {
    passed++;
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
  } else {
    failed++;
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n`);
    process.stdout.write(`      expected: ${JSON.stringify(expected)}\n`);
    process.stdout.write(`      actual:   ${JSON.stringify(actual)}\n`);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// A realistic session: context and cache usage grow over time.
// cacheHit grows as more prior context is served from cache.
const SESSION_GROWING: RequestRecord[] = [
  { endTime:  1, cost: 0.003, inputTokens:  10_000, outputTokens:   800, cacheWriteTokens: 10_000, cacheHitTokens:       0 },
  { endTime:  2, cost: 0.004, inputTokens:  20_000, outputTokens:   900, cacheWriteTokens:  5_000, cacheHitTokens:  10_000 },
  { endTime:  3, cost: 0.006, inputTokens:  35_000, outputTokens: 1_200, cacheWriteTokens:  5_000, cacheHitTokens:  20_000 },
  { endTime:  4, cost: 0.005, inputTokens:  50_000, outputTokens: 1_000, cacheWriteTokens:  5_000, cacheHitTokens:  35_000 },
  { endTime:  5, cost: 0.009, inputTokens:  70_000, outputTokens: 1_800, cacheWriteTokens:  5_000, cacheHitTokens:  50_000 },
  { endTime:  6, cost: 0.007, inputTokens:  90_000, outputTokens: 1_400, cacheWriteTokens:  5_000, cacheHitTokens:  70_000 },
  { endTime:  7, cost: 0.012, inputTokens: 110_000, outputTokens: 2_400, cacheWriteTokens:  5_000, cacheHitTokens:  90_000 },
  { endTime:  8, cost: 0.010, inputTokens: 130_000, outputTokens: 2_000, cacheWriteTokens:  5_000, cacheHitTokens: 110_000 },
  { endTime:  9, cost: 0.015, inputTokens: 148_000, outputTokens: 3_000, cacheWriteTokens:  5_000, cacheHitTokens: 130_000 },
  { endTime: 10, cost: 0.014, inputTokens: 155_000, outputTokens: 2_800, cacheWriteTokens:  5_000, cacheHitTokens: 148_000 },
].map(withCostSplit);

// Uniform cost, growing context — bars grow steadily without spending variance.
const SESSION_FLAT_COST: RequestRecord[] = Array.from({ length: 10 }, (_, i) => withCostSplit({
  endTime:          i + 1,
  cost:             0.005,
  inputTokens:      (i + 1) * 15_000,
  outputTokens:     1_000,
  cacheWriteTokens: 5_000,
  cacheHitTokens:   i * 14_000,
}));

// One expensive spike in the middle.
const SESSION_SPIKE: RequestRecord[] = [
  { endTime: 1, cost: 0.003, inputTokens:  20_000, outputTokens:   800, cacheWriteTokens: 10_000, cacheHitTokens:      0 },
  { endTime: 2, cost: 0.004, inputTokens:  40_000, outputTokens: 1_000, cacheWriteTokens:  5_000, cacheHitTokens: 20_000 },
  { endTime: 3, cost: 0.030, inputTokens:  60_000, outputTokens: 8_000, cacheWriteTokens:  5_000, cacheHitTokens: 40_000 }, // spike
  { endTime: 4, cost: 0.004, inputTokens:  80_000, outputTokens: 1_000, cacheWriteTokens:  5_000, cacheHitTokens: 60_000 },
  { endTime: 5, cost: 0.005, inputTokens: 100_000, outputTokens: 1_200, cacheWriteTokens:  5_000, cacheHitTokens: 80_000 },
].map(withCostSplit);

// ── Graph visual tests ────────────────────────────────────────────────────────

section("Graph — visual (cost sparklines, 4 rows)");

const LIVE: RequestRecord = withCostSplit({
  endTime: Date.now(), cost: 0.008,
  inputTokens: 40_000, outputTokens: 1_500, cacheWriteTokens: 5_000, cacheHitTokens: 20_000,
});

show("Growing session",        graph(SESSION_GROWING));
show("Flat cost, growing ctx", graph(SESSION_FLAT_COST));
show("Cost spike (mid)",       graph(SESSION_SPIKE));
show("1 record",               graph([SESSION_GROWING[0]!]));
show("No records",             graph([]));
show("Live bar, no history",   graph([], LIVE));
show("Live bar mid-session",   graph(SESSION_GROWING.slice(0, 5), LIVE));

// ── Graph correctness checks ──────────────────────────────────────────────────────────────

section("Graph — correctness checks");

check(
  "empty records, no live → empty",
  graph([]),
  "(empty)",
);

// Full cost data → 4 rows, one per type
const fullRecord = withCostSplit({
  endTime: 1, cost: 0.01,
  inputTokens: 10_000, outputTokens: 500, cacheWriteTokens: 1_000, cacheHitTokens: 5_000,
});
const fullLines = renderCostGraph([fullRecord], null, 40);
check("full cost record → 4 rows",  String(fullLines.length), "4");
check("row 0 label is 'cr '",        fullLines[0]?.slice(0, 3) ?? "", "cr ");
check("row 1 label is 'in '",        fullLines[1]?.slice(0, 3) ?? "", "in ");
check("row 2 label is 'cw '",        fullLines[2]?.slice(0, 3) ?? "", "cw ");
check("row 3 label is 'out'",        fullLines[3]?.slice(0, 3) ?? "", "out");

// Records without cost fields → no graph
const noCostRecord: RequestRecord = {
  endTime: 1, cost: 0.01,
  inputTokens: 10_000, outputTokens: 500, cacheWriteTokens: 0, cacheHitTokens: 0,
};
check(
  "records without cost fields → empty",
  renderCostGraph([noCostRecord], null, 40).length === 0 ? "empty" : "non-empty",
  "empty",
);

// Width limits bar count: width=10, label=3 → 7 bars max
const wideRecords = Array.from({ length: 20 }, (_, i) => withCostSplit({
  endTime: i, cost: 0.005,
  inputTokens: 5_000, outputTokens: 500, cacheWriteTokens: 500, cacheHitTokens: i * 1_000,
}));
const narrowLines = renderCostGraph(wideRecords, null, 10);
const narrowBarLen = (narrowLines[0] ?? "").replace(/\x1b\[[^m]*m/g, "").length - 3;
check(
  "width=10 → 7 bars visible",
  String(narrowBarLen),
  "7",
);

// Live record → last bar dimmed
const liveLines = renderCostGraph([SESSION_GROWING[0]!], LIVE, 40);
check(
  "live record → last bar is dimmed",
  (liveLines[0] ?? "").includes("\x1b[2m") ? "dim" : "not-dim",
  "dim",
);

// All-zero cost type rows are suppressed
const noCacheReadRec: RequestRecord = {
  endTime: 1, cost: 0.005,
  inputTokens: 5_000, outputTokens: 500, cacheWriteTokens: 500, cacheHitTokens: 0,
  inputCost: 0.002, outputCost: 0.003, cacheWriteCost: 0.0001, cacheReadCost: 0,
};
const suppLines = renderCostGraph([noCacheReadRec], null, 40);
check(
  "all-zero cr row is suppressed",
  suppLines.some(l => l.startsWith("cr ")) ? "shown" : "hidden",
  "hidden",
);
check(
  "nonzero rows still present when cr is zero",
  String(suppLines.length),
  "3",
);

// ── formatCost checks ─────────────────────────────────────────────────────────

section("formatCost");

check("$0",          formatCost(0),         "$0.0000");
check("$0.01",       formatCost(0.01),       "$0.0100");
check("$0.1",        formatCost(0.1),        "$0.1000");
check("$1.23456",    formatCost(1.23456),    "$1.2346");
check("$0.005",      formatCost(0.005),      "$0.0050");
check("$0.000005",   formatCost(0.000005),   "$0.0000");
check("tiny",        formatCost(0.000001),   "$0.0000");

// ── Status bar visual tests ───────────────────────────────────────────────────

section("Status bar — visual");

show("No records",           renderStatus([]));
show("1 record",             renderStatus([SESSION_GROWING[0]!]));
show("3 records",            renderStatus(SESSION_GROWING.slice(0, 3)));
show("4 records (accel)",    renderStatus(SESSION_GROWING.slice(0, 4)));
show("10 records growing",   renderStatus(SESSION_GROWING));
show("10 records flat",      renderStatus(SESSION_FLAT_COST));

// ── Status bar correctness checks ─────────────────────────────────────────────

section("Status bar — correctness checks");

const emptyParts = buildStatusParts([]);
check("empty → 0 parts",              String(emptyParts.length), "0");

const oneParts = buildStatusParts([SESSION_GROWING[0]!]);
check("1 record → 2 parts",            String(oneParts.length), "2");
check("1 record → muted /req part",   oneParts[0]?.style ?? "", "muted");

// Cost accumulation: 4 records, early cheaper than recent → warning multiplier
const accelRecords: RequestRecord[] = [
  { endTime: 1, cost: 0.001, inputTokens: 1_000, outputTokens: 100, cacheWriteTokens: 0, cacheHitTokens: 0 },
  { endTime: 2, cost: 0.001, inputTokens: 2_000, outputTokens: 100, cacheWriteTokens: 0, cacheHitTokens: 0 },
  { endTime: 3, cost: 0.005, inputTokens: 3_000, outputTokens: 500, cacheWriteTokens: 0, cacheHitTokens: 0 },
  { endTime: 4, cost: 0.005, inputTokens: 4_000, outputTokens: 500, cacheWriteTokens: 0, cacheHitTokens: 0 },
].map(withCostSplit);
const accelParts = buildStatusParts(accelRecords);
check("accel → 3 parts",              String(accelParts.length), "3");
check("accel → last part is warning", accelParts[2]?.style ?? "", "warning");
check("accel → multiplier shown",     accelParts[2]?.text.startsWith("+") ?? false ? "yes" : "no", "yes");

// Stable: all equal cost → no multiplier annotation
const stableRecords: RequestRecord[] = Array.from({ length: 4 }, (_, i) => withCostSplit({
  endTime: i, cost: 0.005,
  inputTokens: 5_000, outputTokens: 500, cacheWriteTokens: 0, cacheHitTokens: 0,
}));
const stableParts = buildStatusParts(stableRecords);
check("stable cost → 2 parts (no multiplier)", String(stableParts.length), "2");

// Declining cost → success style
const decliningRecords: RequestRecord[] = [
  { endTime: 1, cost: 0.010, inputTokens: 10_000, outputTokens: 1_000, cacheWriteTokens: 0, cacheHitTokens: 0 },
  { endTime: 2, cost: 0.010, inputTokens: 10_000, outputTokens: 1_000, cacheWriteTokens: 0, cacheHitTokens: 0 },
  { endTime: 3, cost: 0.001, inputTokens:  1_000, outputTokens:   100, cacheWriteTokens: 0, cacheHitTokens: 0 },
  { endTime: 4, cost: 0.001, inputTokens:  1_000, outputTokens:   100, cacheWriteTokens: 0, cacheHitTokens: 0 },
].map(withCostSplit);
const decliningParts = buildStatusParts(decliningRecords);
check("declining → last part is success",      decliningParts[2]?.style ?? "", "success");

// Cost breakdown: verify per-type costs appear and are individually correct
const breakdownRec: RequestRecord = {
  endTime: 1, cost: 0.020,
  inputTokens: 10_000, outputTokens: 2_000, cacheWriteTokens: 4_000, cacheHitTokens: 50_000,
  inputCost: 0.003, outputCost: 0.015, cacheWriteCost: 0.001, cacheReadCost: 0.001,
};
const breakdownParts = buildStatusParts([breakdownRec]);
const breakdownText  = breakdownParts[1]?.text ?? "";
check("breakdown part is dim",          breakdownParts[1]?.style ?? "", "dim");
check("breakdown contains cr cost",     breakdownText.includes("cr:") ? "yes" : "no", "yes");
check("breakdown contains in cost",     breakdownText.includes("in:") ? "yes" : "no", "yes");
check("breakdown contains cw cost",     breakdownText.includes("cw:") ? "yes" : "no", "yes");
check("breakdown contains out cost",    breakdownText.includes("out:") ? "yes" : "no", "yes");
check("breakdown cr value",             breakdownText.match(/cr:(\S+)/)?.[1] ?? "", "$0.001");
check("breakdown in value",             breakdownText.match(/in:(\S+)/)?.[1] ?? "", "$0.003");
check("breakdown cw value",             breakdownText.match(/cw:(\S+)/)?.[1] ?? "", "$0.001");
check("breakdown out value",            breakdownText.match(/out:(\S+)/)?.[1] ?? "", "$0.015");
// Records without per-type costs still show no breakdown part
const noBreakdownRec: RequestRecord = {
  endTime: 1, cost: 0.005,
  inputTokens: 5_000, outputTokens: 500, cacheWriteTokens: 0, cacheHitTokens: 0,
};
const noBreakdownParts = buildStatusParts([noBreakdownRec]);
check("no cost fields → only 1 part",   String(noBreakdownParts.length), "1");

// ── Detail report ─────────────────────────────────────────────────────────────

section("Detail report");

const now = Date.now();
process.stdout.write(buildDetailReport(SESSION_GROWING, now - 5 * 60_000, DEFAULT_BUDGET) + "\n\n");

check("no records → message",
  buildDetailReport([], now, DEFAULT_BUDGET),
  "No completed requests yet.",
);

// ── Summary ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${"─".repeat(48)}\n`);
if (failed === 0) {
  process.stdout.write(`\x1b[32m✓ All ${passed} checks passed\x1b[0m\n\n`);
} else {
  process.stdout.write(`\x1b[31m✗ ${failed} failed, ${passed} passed\x1b[0m\n\n`);
  process.exit(1);
}
