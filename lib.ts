/**
 * pi-burn core logic — no pi dependencies, fully testable standalone.
 */

// Session spend limit in dollars. At 40% of this value the graph turns yellow
// ($4 on the default $10 budget); at 100% it turns fully red.
export const DEFAULT_BUDGET = 10;

export type RequestRecord = {
  endTime: number;       // ms epoch
  cost: number;          // USD total
  inputTokens: number;   // non-cached input tokens for the run
  outputTokens: number;  // total output tokens for the run
  cacheWriteTokens: number;
  cacheHitTokens: number;
  // Per-type cost breakdown; all four sum to `cost`.
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
};

// t=0 => green, t=0.4 => yellow, t=1 => red
export function burnColor(t: number): string {
  const r = Math.round(Math.min(1, t / 0.4) * 220);
  const g = Math.round(Math.min(1, (1 - t) / 0.6) * 200);
  return `\x1b[38;2;${r};${g};0m`;
}

const ANSI_RESET = "\x1b[0m";

function tokenTotal(r: RequestRecord): number {
  return r.inputTokens + r.outputTokens + r.cacheWriteTokens + r.cacheHitTokens;
}

// ── Graph ─────────────────────────────────────────────────────────────────────
//
// Returns one row per cost type (cr, in, cw, out), each a labeled sparkline
// of that cost across round trips.  Rows are omitted when all values are zero.
//
// All four rows share the same scale (based on the per-type max across the
// visible window) so relative heights are directly comparable.
//
// Pass a partial `liveRecord` for the current in-flight request; its bar
// appears dim at the right edge while the request is still streaming.
//
// Block characters give 9 height levels (space + ▁▂▃▄▅▆▇█).

const BLOCK_CHARS = " ▁▂▃▄▅▆▇█";

// cr=cyan  in=green  cw=amber  out=orange-red
const COLOR_CACHE_READ  = "\x1b[38;2;0;180;200m";
const COLOR_INPUT       = "\x1b[38;2;80;190;80m";
const COLOR_CACHE_WRITE = "\x1b[38;2;210;170;0m";
const COLOR_OUTPUT      = "\x1b[38;2;220;80;0m";
const DIM               = "\x1b[2m";

export function renderCostGraph(
  records: RequestRecord[],
  liveRecord: RequestRecord | null,
  width: number,
): string[] {
  const allData = liveRecord ? [...records, liveRecord] : records;
  if (allData.length === 0) return [];

  const hasCosts = allData.some(
    r => r.inputCost != null || r.outputCost != null ||
         r.cacheReadCost != null || r.cacheWriteCost != null,
  );
  if (!hasCosts) return [];

  // Label prefix is 3 chars ("cr ", "in ", "cw ", "out").
  const LABEL_WIDTH = 3;
  const barWidth = Math.max(1, width - LABEL_WIDTH);
  const data = allData.slice(-barWidth);

  // Shared scale: max single-type cost across all visible records.
  const maxVal = Math.max(
    1e-9,
    ...data.flatMap(r => [
      r.cacheReadCost  ?? 0,
      r.inputCost      ?? 0,
      r.cacheWriteCost ?? 0,
      r.outputCost     ?? 0,
    ]),
  );

  const liveIdx = liveRecord ? data.length - 1 : -1;

  function toChar(v: number): string {
    const level = Math.round((v / maxVal) * 8);
    return BLOCK_CHARS[Math.max(0, Math.min(8, level))]!;
  }

  function makeRow(
    label: string,
    color: string,
    getter: (r: RequestRecord) => number,
  ): string | null {
    const values = data.map(getter);
    if (values.every(v => v === 0)) return null;
    let row = label;
    for (let i = 0; i < data.length; i++) {
      const ch = toChar(values[i]!);
      row += i === liveIdx
        ? `${DIM}${ch}${ANSI_RESET}`
        : `${color}${ch}${ANSI_RESET}`;
    }
    return row;
  }

  return [
    makeRow("cr ", COLOR_CACHE_READ,  r => r.cacheReadCost  ?? 0),
    makeRow("in ", COLOR_INPUT,       r => r.inputCost      ?? 0),
    makeRow("cw ", COLOR_CACHE_WRITE, r => r.cacheWriteCost ?? 0),
    makeRow("out", COLOR_OUTPUT,      r => r.outputCost     ?? 0),
  ].filter((row): row is string => row !== null);
}

// ── Status bar ────────────────────────────────────────────────────────────────

export type StatusStyle = "dim" | "muted" | "warning" | "success";

export type StatusPart = {
  text: string;
  style: StatusStyle;
};

/**
 * Returns the status bar as an array of styled parts. The caller (extension or
 * test) decides how to apply the styles — the extension uses pi's theme.fg(),
 * tests can apply simple ANSI codes directly.
 */
export function buildStatusParts(records: RequestRecord[]): StatusPart[] {
  if (records.length === 0) {
    return [];
  }

  const parts: StatusPart[] = [];

  if (records.length >= 1) {
    const window = records.slice(-3);
    const windowAvg = window.reduce((s, r) => s + r.cost, 0) / window.length;
    parts.push({ text: `${formatCost(windowAvg)}/req`, style: "muted" });

    const hasCostBreakdown = window.some(
      r => r.inputCost != null || r.outputCost != null ||
           r.cacheReadCost != null || r.cacheWriteCost != null,
    );

    if (hasCostBreakdown) {
      const avg = (fn: (r: RequestRecord) => number | undefined) =>
        window.reduce((s, r) => s + (fn(r) ?? 0), 0) / window.length;

      const avgCacheRead  = avg(r => r.cacheReadCost);
      const avgInput      = avg(r => r.inputCost);
      const avgCacheWrite = avg(r => r.cacheWriteCost);
      const avgOutput     = avg(r => r.outputCost);

      const fmt = (n: number) => `$${n.toFixed(3)}`;
      const breakdown = [
        avgCacheRead  > 0 ? `cr:${fmt(avgCacheRead)}`  : null,
        avgInput      > 0 ? `in:${fmt(avgInput)}`      : null,
        avgCacheWrite > 0 ? `cw:${fmt(avgCacheWrite)}` : null,
        avgOutput     > 0 ? `out:${fmt(avgOutput)}`    : null,
      ].filter(Boolean).join("  ");

      if (breakdown) {
        parts.push({ text: breakdown, style: "dim" });
      }
    }
  }

  if (records.length >= 4) {
    const mid = Math.floor(records.length / 2);
    const earlyAvg  = records.slice(0, mid).reduce((s, r) => s + r.cost, 0) / mid;
    const recentAvg = records.slice(mid).reduce((s, r) => s + r.cost, 0) / (records.length - mid);
    const multiplier = earlyAvg > 0 ? recentAvg / earlyAvg : 1;

    if (multiplier > 1.05) {
      parts.push({ text: `+${multiplier.toFixed(1)}x`, style: "warning" });
    } else if (multiplier < 0.95) {
      parts.push({ text: `${multiplier.toFixed(1)}x`, style: "success" });
    }
  }

  return parts;
}

// ── Detail report ─────────────────────────────────────────────────────────────

export function buildDetailReport(
  records: RequestRecord[],
  sessionStartTime: number,
  budget: number,
): string {
  if (records.length === 0) return "No completed requests yet.";

  const totalCost = records.reduce((s, r) => s + r.cost, 0);
  const sessionMinutes = Math.max((Date.now() - sessionStartTime) / 60_000, 0.001);
  const avgPerReq = totalCost / records.length;

  const lines: string[] = [
    `Requests:     ${records.length}`,
    `Total cost:   $${totalCost.toFixed(4)}`,
    `Session time: ${sessionMinutes.toFixed(1)} min`,
    `Avg /req:     ${formatCost(avgPerReq)}`,
    `Avg /min:     ${formatCost(totalCost / sessionMinutes)}`,
    `Budget:       $${budget.toFixed(2)}  ${burnColor(0.4)}●${ANSI_RESET} $${(budget * 0.4).toFixed(2)}  ${burnColor(1)}●${ANSI_RESET} $${budget.toFixed(2)}`,
  ];

  if (records.length >= 2) {
    const first = records[0].cost;
    const last  = records[records.length - 1].cost;
    const multiplier = first > 0 ? last / first : 1;
    lines.push(`First req:    ${formatCost(first)}`);
    lines.push(`Most recent:  ${formatCost(last)}  (${multiplier.toFixed(2)}x first)`);
  }

  if (records.length >= 4) {
    lines.push("");
    lines.push("Per-request cost history:");
    records.forEach((r, i) => {
      const ctxTokens = tokenTotal(r) - r.outputTokens;
      const ctx = ctxTokens > 0
        ? `  ${(ctxTokens / 1000).toFixed(0)}k ctx`
        : "";
      lines.push(`  [${String(i + 1).padStart(2)}]  ${formatCost(r.cost)}${ctx}`);
    });
  }

  return lines.join("\n");
}

// ── Shared formatting ─────────────────────────────────────────────────────────

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}


