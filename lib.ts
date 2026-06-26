/**
 * pi-burn core logic — no pi dependencies, fully testable standalone.
 */

// Session spend limit in dollars. At 40% of this value the graph turns yellow
// ($4 on the default $10 budget); at 100% it turns fully red.
export const DEFAULT_BUDGET = 10;

export type RequestRecord = {
  endTime: number;       // ms epoch
  cost: number;          // USD
  inputTokens: number;   // non-cached input tokens for the run
  outputTokens: number;  // total output tokens for the run
  cacheWriteTokens: number;
  cacheHitTokens: number;
};

// ── Braille helpers ──────────────────────────────────────────────────────────
//
// Braille Unicode dot layout (U+2800 base, one bit per dot):
//
//   left  right
//   ────  ─────
//   dot1  dot4   bit 0 (1),   bit 3 (8)
//   dot2  dot5   bit 1 (2),   bit 4 (16)
//   dot3  dot6   bit 2 (4),   bit 5 (32)
//   dot7  dot8   bit 6 (64),  bit 7 (128)
//
// To fill a column as a bar from the bottom up we light dots in this order:
//   left  column: dot7(64), dot3(4), dot2(2), dot1(1)
//   right column: dot8(128), dot6(32), dot5(16), dot4(8)

const COL_LEFT_BITS  = [64, 4, 2, 1] as const;
const COL_RIGHT_BITS = [128, 32, 16, 8] as const;

export function brailleChar(leftHeight: number, rightHeight: number): string {
  let bits = 0;
  for (let i = 0; i < leftHeight;  i++) bits |= COL_LEFT_BITS[i]!;
  for (let i = 0; i < rightHeight; i++) bits |= COL_RIGHT_BITS[i]!;
  return String.fromCodePoint(0x2800 + bits);
}

// t=0 => green, t=0.4 => yellow, t=1 => red
export function burnColor(t: number): string {
  const r = Math.round(Math.min(1, t / 0.4) * 220);
  const g = Math.round(Math.min(1, (1 - t) / 0.6) * 200);
  return `\x1b[38;2;${r};${g};0m`;
}

const ANSI_RESET = "\x1b[0m";

// ── Token type colors ────────────────────────────────────────────────────────
//
// Stacking order in the bar, bottom to top:
//   cacheHit (cheapest)  →  input  →  cacheWrite  →  output (priciest)
//
const COLOR_CACHE_HIT   = "\x1b[38;2;0;180;200m";   // cyan
const COLOR_INPUT       = "\x1b[38;2;80;190;80m";    // green
const COLOR_CACHE_WRITE = "\x1b[38;2;210;170;0m";    // amber
const COLOR_OUTPUT      = "\x1b[38;2;220;80;0m";     // orange-red

function tokenTotal(r: RequestRecord): number {
  return r.inputTokens + r.outputTokens + r.cacheWriteTokens + r.cacheHitTokens;
}

// Given a vertical midpoint `dotMid` in 0-8 dot space and a scale factor
// (scale = 8 / maxTotal across visible window), return the ANSI color for the
// token zone occupying that position in record `r`'s stacked bar.
function tokenZoneColor(dotMid: number, r: RequestRecord, scale: number): string {
  const z0 = r.cacheHitTokens * scale;
  const z1 = (r.cacheHitTokens + r.inputTokens) * scale;
  const z2 = (r.cacheHitTokens + r.inputTokens + r.cacheWriteTokens) * scale;
  if (dotMid < z0) return COLOR_CACHE_HIT;
  if (dotMid < z1) return COLOR_INPUT;
  if (dotMid < z2) return COLOR_CACHE_WRITE;
  return COLOR_OUTPUT;
}

// ── Graph ─────────────────────────────────────────────────────────────────────
//
// Returns two lines: [topRow, bottomRow].  Each column encodes two adjacent
// data points as a single braille character (left = older, right = newer).
//
// Bar HEIGHT represents total tokens for that request (input + output +
// cache_write + cache_hit), scaled to the session max.  Two rows of braille
// give 8 dot levels of resolution so small changes are visible.
//
// Bar COLOR shows the token breakdown as a stacked bar:
//   bottom → top:  cacheHit (cyan)  input (green)  cacheWrite (amber)  output (orange)
//
// Pass a partial `liveRecord` built from the current in-flight request to show
// a live bar at the right edge while the request is streaming.
//
export function renderBurnGraph(
  records: RequestRecord[],
  liveRecord: RequestRecord | null,
  width: number,
): string[] {
  const allData = liveRecord ? [...records, liveRecord] : records;
  if (allData.length === 0) return [];

  // Most-recent slice that fits the terminal width (2 data points per char).
  const data = allData.slice(-(width * 2));

  const maxTotal = Math.max(1, ...data.map(tokenTotal));
  const scale    = 8 / maxTotal; // maps token count → 0-8 dot space

  // If the slice has an odd length, start at index -1 so the very first char
  // uses only its right column, keeping the newest point flush-right.
  const startIdx = -(data.length % 2);

  let topLine    = "";
  let bottomLine = "";

  for (let i = startIdx; i < data.length; i += 2) {
    const lRec = i >= 0              ? data[i]!     : null;
    const rRec = i + 1 < data.length ? data[i + 1]! : null;

    const lDots = lRec ? Math.round(tokenTotal(lRec) * scale) : 0;
    const rDots = rRec ? Math.round(tokenTotal(rRec) * scale) : 0;

    // Bottom row: lower 4 dots of each sub-column bar
    const lBot = Math.min(4, lDots);
    const rBot = Math.min(4, rDots);
    // Top row: upper 4 dots (only present when bar exceeds 4 dots)
    const lTop = Math.max(0, lDots - 4);
    const rTop = Math.max(0, rDots - 4);

    // Color representative for the char: prefer the right (newer) record.
    const repRec = rRec ?? lRec!;

    // Bottom-row color: midpoint of the right sub-column's fill in that row.
    const rBotMid = rBot / 2;
    const botColor = (lBot > 0 || rBot > 0)
      ? tokenZoneColor(rBotMid, repRec, scale)
      : "";

    // Top-row color: midpoint of the right sub-column's fill, offset by 4.
    const rTopMid = 4 + rTop / 2;
    const topColor = (lTop > 0 || rTop > 0)
      ? tokenZoneColor(rTopMid, repRec, scale)
      : "";

    topLine += (lTop > 0 || rTop > 0)
      ? topColor + brailleChar(lTop, rTop) + ANSI_RESET
      : " ";
    bottomLine += (lBot > 0 || rBot > 0)
      ? botColor + brailleChar(lBot, rBot) + ANSI_RESET
      : brailleChar(0, 0); // empty braille for alignment
  }

  return [topLine, bottomLine];
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
      const ctx = (r.inputTokens + r.cacheHitTokens) > 0
        ? `  ${((r.inputTokens + r.cacheHitTokens) / 1000).toFixed(0)}k ctx`
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
