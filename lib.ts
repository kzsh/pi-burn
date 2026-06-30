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

// cr=cyan  in=green  cw=amber  out=orange-red
const COLOR_CACHE_READ  = "\x1b[38;2;0;180;200m";
const COLOR_INPUT       = "\x1b[38;2;80;190;80m";
const COLOR_CACHE_WRITE = "\x1b[38;2;210;170;0m";
const COLOR_OUTPUT      = "\x1b[38;2;220;80;0m";
const DIM               = "\x1b[2m";

// Braille dot layout (U+2800 base, one bit per dot):
//
//   left  right
//   dot7  dot8   bit 6 (64),  bit 7 (128)  ← top row
//   dot3  dot6   bit 2 (4),   bit 5 (32)
//   dot2  dot5   bit 1 (2),   bit 4 (16)
//   dot1  dot4   bit 0 (1),   bit 3 (8)    ← bottom row
//
// Filling from bottom up:
//   left column:  dot7(64), dot3(4), dot2(2), dot1(1)
//   right column: dot8(128), dot6(32), dot5(16), dot4(8)

const COL_LEFT_BITS  = [64, 4, 2, 1] as const;
const COL_RIGHT_BITS = [128, 32, 16, 8] as const;

function brailleChar(leftHeight: number, rightHeight: number): string {
  let bits = 0;
  for (let i = 0; i < leftHeight;  i++) bits |= COL_LEFT_BITS[i]!;
  for (let i = 0; i < rightHeight; i++) bits |= COL_RIGHT_BITS[i]!;
  return String.fromCodePoint(0x2800 + bits);
}

// Stacking order bottom→top: cr  in  cw  out
// Returns the color for the cost type occupying `dotMid` in record `r`.
function costZoneColor(dotMid: number, r: RequestRecord, scale: number): string {
  const z0 = (r.cacheReadCost  ?? 0) * scale;
  const z1 = z0 + (r.inputCost ?? 0) * scale;
  const z2 = z1 + (r.cacheWriteCost ?? 0) * scale;
  if (dotMid < z0) return COLOR_CACHE_READ;
  if (dotMid < z1) return COLOR_INPUT;
  if (dotMid < z2) return COLOR_CACHE_WRITE;
  return COLOR_OUTPUT;
}

// Legend split across the two braille rows (stacking order, bottom first):
//   bottom row gets:  ●cr ●in   (the types that occupy the lower height bands)
//   top row gets:     ●cw ●out  (the types that occupy the upper height bands)
//
// Both legends are 10 visible chars: "  \u25cfxx \u25cfyyy" where xxx is padded to match.
const LEGEND_W = 10; // "  ●xx ●yyy" → 2+1+2+1+1+3 = 10

export function renderCostGraph(
  records: RequestRecord[],
  liveRecord: RequestRecord | null,
  width: number,
  showLegend = true,
): string[] {
  const allData = liveRecord ? [...records, liveRecord] : records;
  if (allData.length === 0) return [];

  const hasCosts = allData.some(
    r => r.inputCost != null || r.outputCost != null ||
         r.cacheReadCost != null || r.cacheWriteCost != null,
  );
  if (!hasCosts) return [];

  // Each braille char covers 2 data points (left + right column).
  // Reserve space for the legend only when it is shown.
  const barWidth = Math.max(1, showLegend ? width - LEGEND_W : width);
  const data = allData.slice(-(barWidth * 2));

  const maxCost = Math.max(
    1e-9,
    ...data.map(r =>
      (r.cacheReadCost  ?? 0) +
      (r.inputCost      ?? 0) +
      (r.cacheWriteCost ?? 0) +
      (r.outputCost     ?? 0),
    ),
  );
  const scale = 8 / maxCost;

  // Index of the braille char that contains the live record (rightmost char).
  const liveCharIdx = liveRecord ? Math.ceil(data.length / 2) - 1 : -1;

  let topLine    = "";
  let bottomLine = "";

  for (let i = 0; i < data.length; i += 2) {
    const lastAlone = (data.length % 2 === 1) && (i === data.length - 1);
    const lRec = lastAlone ? null     : data[i]!;
    const rRec = lastAlone ? data[i]! : (i + 1 < data.length ? data[i + 1]! : null);

    const totalCost = (r: RequestRecord) =>
      (r.cacheReadCost ?? 0) + (r.inputCost ?? 0) +
      (r.cacheWriteCost ?? 0) + (r.outputCost ?? 0);

    const lDots = lRec ? Math.round(totalCost(lRec) * scale) : 0;
    const rDots = rRec ? Math.round(totalCost(rRec) * scale) : 0;

    const lBot = Math.min(4, lDots);
    const rBot = Math.min(4, rDots);
    const lTop = Math.max(0, lDots - 4);
    const rTop = Math.max(0, rDots - 4);

    // Use the right (newer) record for color, falling back to left.
    const repRec = rRec ?? lRec!;
    const charIdx = i / 2;
    const isLive  = charIdx === liveCharIdx;

    const rBotMid = rBot / 2;
    const botColor = (lBot > 0 || rBot > 0) ? costZoneColor(rBotMid, repRec, scale) : "";
    const rTopMid = 4 + rTop / 2;
    const topColor = (lTop > 0 || rTop > 0) ? costZoneColor(rTopMid, repRec, scale) : "";

    const topCh = (lTop > 0 || rTop > 0) ? topColor + brailleChar(lTop, rTop) + ANSI_RESET : " ";
    const botCh = (lBot > 0 || rBot > 0) ? botColor + brailleChar(lBot, rBot) + ANSI_RESET
                                          : brailleChar(0, 0);

    topLine    += isLive ? DIM + topCh + ANSI_RESET : topCh;
    bottomLine += isLive ? DIM + botCh + ANSI_RESET : botCh;
  }

  // Left-pad bars so the legend is always flush at the right edge.
  const charCount = Math.ceil(data.length / 2);
  const pad = " ".repeat(Math.max(0, barWidth - charCount));

  if (!showLegend) {
    return [pad + topLine, pad + bottomLine];
  }

  const topLegend = `  ${COLOR_CACHE_WRITE}\u25cf${ANSI_RESET}cw ${COLOR_OUTPUT}\u25cf${ANSI_RESET}out`;
  const botLegend = `  ${COLOR_CACHE_READ}\u25cf${ANSI_RESET}cr ${COLOR_INPUT}\u25cf${ANSI_RESET}in `;

  return [pad + topLine + topLegend, pad + bottomLine + botLegend];
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
        `cr:${fmt(avgCacheRead)}`,
        `in:${fmt(avgInput)}`,
        `cw:${fmt(avgCacheWrite)}`,
        `out:${fmt(avgOutput)}`,
      ].join("  ");

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


