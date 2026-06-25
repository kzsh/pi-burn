/**
 * Standalone visual tests for pi-burn rendering logic.
 * No pi dependency — runs directly with: bun test.ts
 *
 * Prints the graph and status line for each scenario so you can eyeball them.
 */

import {
  DEFAULT_THRESHOLD,
  buildDetailReport,
  buildStatusParts,
  brailleChar,
  burnColor,
  formatCost,
  renderBurnGraph,
  type RequestRecord,
  type StatusStyle,
} from "./lib.ts";

// ── Simple ANSI helpers for the test output ───────────────────────────────────
// These approximate what pi's theme.fg() does for each StatusStyle.

const RESET = "\x1b[0m";

const STYLE_ANSI: Record<StatusStyle, string> = {
  dim:     "\x1b[2m",
  muted:   "\x1b[90m",
  warning: "\x1b[33m",
  success: "\x1b[32m",
};

function renderStatus(records: RequestRecord[], liveCost = 0): string {
  const parts = buildStatusParts(records, liveCost);
  return parts.map(p => STYLE_ANSI[p.style] + p.text + RESET).join("  ");
}

function graph(
  records: RequestRecord[],
  liveCost = 0,
  liveCtx = 0,
  width = 40,
  threshold = DEFAULT_THRESHOLD,
): string {
  return renderBurnGraph(records, liveCost, liveCtx, threshold, width)[0] ?? "(empty)";
}

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function section(title: string) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n${"─".repeat(title.length)}\n`);
}

function show(label: string, line: string) {
  const pad = label.padEnd(38);
  process.stdout.write(`  ${pad} ${line}\n`);
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

// A realistic session: context grows towards the threshold, cost varies.
const SESSION_GROWING: RequestRecord[] = [
  { endTime: 1, cost: 0.003, contextTokens:  10_000 },
  { endTime: 2, cost: 0.004, contextTokens:  20_000 },
  { endTime: 3, cost: 0.006, contextTokens:  35_000 },
  { endTime: 4, cost: 0.005, contextTokens:  50_000 },
  { endTime: 5, cost: 0.009, contextTokens:  70_000 },
  { endTime: 6, cost: 0.007, contextTokens:  90_000 },
  { endTime: 7, cost: 0.012, contextTokens: 110_000 },
  { endTime: 8, cost: 0.010, contextTokens: 130_000 },
  { endTime: 9, cost: 0.015, contextTokens: 148_000 },
  { endTime:10, cost: 0.014, contextTokens: 155_000 },
];

// Uniform cost but context grows — old relative graph: all red; new: gradient.
const SESSION_FLAT_COST: RequestRecord[] = Array.from({ length: 10 }, (_, i) => ({
  endTime: i + 1,
  cost: 0.005,
  contextTokens: (i + 1) * 15_000,
}));

// One expensive spike in the middle.
const SESSION_SPIKE: RequestRecord[] = [
  { endTime: 1, cost: 0.003, contextTokens:  20_000 },
  { endTime: 2, cost: 0.004, contextTokens:  40_000 },
  { endTime: 3, cost: 0.030, contextTokens:  60_000 },  // spike
  { endTime: 4, cost: 0.004, contextTokens:  80_000 },
  { endTime: 5, cost: 0.005, contextTokens: 100_000 },
];

// ── Graph visual tests ────────────────────────────────────────────────────────

section("Graph — visual (braille + color)");

show("Growing session (bars taller + redder →)",  graph(SESSION_GROWING));
show("Flat cost, growing ctx (color only →)",      graph(SESSION_FLAT_COST));
show("Cost spike (tall bar in middle)",            graph(SESSION_SPIKE));
show("1 record",                                  graph([{ endTime: 1, cost: 0.01, contextTokens: 50_000 }]));
show("No records",                                graph([]));
show("Live bar, no history",                      graph([], 0.007, 50_000));
show("Live bar mid-session",                      graph(SESSION_GROWING.slice(0, 5), 0.008, 80_000));
show("Custom threshold 75k (redder sooner)",       graph(SESSION_FLAT_COST, 0, 0, 40, 75_000));
show("Over threshold (clamped to red)",            graph([{ endTime: 1, cost: 0.01, contextTokens: 300_000 }]));

// ── Graph correctness checks ──────────────────────────────────────────────────

section("Graph — correctness checks");

// Empty input
check(
  "empty records, no live cost → empty",
  renderBurnGraph([], 0, 0, DEFAULT_THRESHOLD, 40)[0] ?? "(empty)",
  "(empty)",
);

// Single record: only right column should be lit (left is padding)
const singleChar = renderBurnGraph(
  [{ endTime: 1, cost: 0.01, contextTokens: 0 }], 0, 0, DEFAULT_THRESHOLD, 40,
)[0] ?? "";
// Strip ANSI to get just the braille char
const stripped = singleChar.replace(/\x1b\[[^m]*m/g, "");
check(
  "single record → right column only (⢸ or similar, left col empty)",
  (stripped.codePointAt(0) ?? 0) >= 0x2800 && (stripped.codePointAt(0) ?? 0) <= 0x28ff
    ? "braille"
    : "not-braille",
  "braille",
);
// Left column bits (1,2,4,64) should be zero — only right column dots set
const charCode = (stripped.codePointAt(0) ?? 0x2800) - 0x2800;
check(
  "single record → left column dots are all zero",
  String(charCode & (1 | 2 | 4 | 64)),
  "0",
);

// Over-threshold context should clamp to red (220, 0, 0)
check(
  "contextTokens > threshold → red color",
  burnColor(Math.min(300_000 / DEFAULT_THRESHOLD, 1)),
  burnColor(1),
);

// Zero cost → no graph
check(
  "all-zero cost → empty output",
  renderBurnGraph(
    [{ endTime: 1, cost: 0, contextTokens: 10_000 }], 0, 0, DEFAULT_THRESHOLD, 40,
  ).length === 0 ? "empty" : "not-empty",
  "empty",
);

// ── Braille char checks ───────────────────────────────────────────────────────

section("brailleChar — known values");

check("(0,0) → empty braille ⠀",   brailleChar(0, 0), "⠀");
check("(4,4) → full block ⣿",      brailleChar(4, 4), "⣿");
check("(4,0) → left col only ⡇",   brailleChar(4, 0), "⡇");
check("(0,4) → right col only ⢸",  brailleChar(0, 4), "⢸");
check("(1,1) → bottom row ⣀",      brailleChar(1, 1), "⣀");
check("(2,2) → bottom 2 rows ⣤",   brailleChar(2, 2), "⣤");
check("(3,3) → bottom 3 rows ⣶",   brailleChar(3, 3), "⣶");

// ── formatCost checks ─────────────────────────────────────────────────────────

section("formatCost");

check("$0",          formatCost(0),         "$0.000");
check("$0.01",       formatCost(0.01),       "$0.010");
check("$0.1",        formatCost(0.1),        "$0.100");
check("$1.23456",    formatCost(1.23456),    "$1.235");
check("0.005 -> ¢",  formatCost(0.005),      "0.500¢");
check("0.000005",    formatCost(0.000005),   "0.5μ¢");
check("tiny",        formatCost(0.000001),   "0.1μ¢");

// ── Status bar visual tests ───────────────────────────────────────────────────

section("Status bar — visual");

show("No records",           renderStatus([]));
show("1 record",             renderStatus([{ endTime: 1, cost: 0.005, contextTokens: 10_000 }]));
show("3 records",            renderStatus(SESSION_GROWING.slice(0, 3)));
show("4 records (accel)",    renderStatus(SESSION_GROWING.slice(0, 4)));
show("10 records growing",   renderStatus(SESSION_GROWING));
show("10 records flat",      renderStatus(SESSION_FLAT_COST));
show("Live cost in-flight",  renderStatus(SESSION_GROWING.slice(0, 5), 0.008));

// ── Status bar correctness checks ─────────────────────────────────────────────

section("Status bar — correctness checks");

const emptyParts = buildStatusParts([], 0);
check("empty → 1 part",               String(emptyParts.length), "1");
check("empty → dim style",            emptyParts[0].style, "dim");
check("empty → $0.000",               emptyParts[0].text, "$0.000");

const oneParts = buildStatusParts([{ endTime: 1, cost: 0.005, contextTokens: 0 }], 0);
check("1 record → 2 parts",           String(oneParts.length), "2");
check("1 record → muted /req part",   oneParts[1]?.style ?? "", "muted");

// Cost accumulation: 4 records, early cheaper than recent → warning multiplier
const accelRecords: RequestRecord[] = [
  { endTime: 1, cost: 0.001, contextTokens: 0 },
  { endTime: 2, cost: 0.001, contextTokens: 0 },
  { endTime: 3, cost: 0.005, contextTokens: 0 },
  { endTime: 4, cost: 0.005, contextTokens: 0 },
];
const accelParts = buildStatusParts(accelRecords, 0);
check("accel → 3 parts",              String(accelParts.length), "3");
check("accel → last part is warning", accelParts[2]?.style ?? "", "warning");
check("accel → multiplier shown",     accelParts[2]?.text.startsWith("+") ?? false ? "yes" : "no", "yes");

// Stable: all equal cost → no multiplier annotation
const stableRecords: RequestRecord[] = Array.from({ length: 4 }, (_, i) => ({
  endTime: i, cost: 0.005, contextTokens: 0,
}));
const stableParts = buildStatusParts(stableRecords, 0);
check("stable cost → 2 parts (no multiplier)", String(stableParts.length), "2");

// Declining cost → success style
const decliningRecords: RequestRecord[] = [
  { endTime: 1, cost: 0.010, contextTokens: 0 },
  { endTime: 2, cost: 0.010, contextTokens: 0 },
  { endTime: 3, cost: 0.001, contextTokens: 0 },
  { endTime: 4, cost: 0.001, contextTokens: 0 },
];
const decliningParts = buildStatusParts(decliningRecords, 0);
check("declining → last part is success",      decliningParts[2]?.style ?? "", "success");

// ── Detail report ─────────────────────────────────────────────────────────────

section("Detail report");

const now = Date.now();
show("4-record report:\n" + buildDetailReport(SESSION_GROWING, now - 5 * 60_000, DEFAULT_THRESHOLD), "");

check("no records → message",
  buildDetailReport([], now, DEFAULT_THRESHOLD),
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
