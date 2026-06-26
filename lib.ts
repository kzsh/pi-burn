/**
 * pi-burn core logic — no pi dependencies, fully testable standalone.
 */

// Session spend limit in dollars. At 40% of this value the graph turns yellow
// ($4 on the default $10 budget); at 100% it turns fully red.
export const DEFAULT_BUDGET = 10;

export type RequestRecord = {
  endTime: number;      // ms epoch
  cost: number;         // USD
  contextTokens: number; // msg.usage.input of last assistant turn in the run
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

// ── Graph ─────────────────────────────────────────────────────────────────────

export function renderBurnGraph(
  records: RequestRecord[],
  currentRequestCost: number,
  budget: number,
  width: number,
): string[] {
  // Append in-progress request as a live bar at the right edge.
  const allData: RequestRecord[] = currentRequestCost > 0
    ? [...records, { endTime: Date.now(), cost: currentRequestCost, contextTokens: 0 }]
    : records;

  if (allData.length === 0) return [];

  // Compute cumulative spend at each data point. Both height and color encode
  // this value: bars grow taller and redder as the session budget is consumed.
  // At budget/2 the graph turns yellow; at budget it turns fully red.
  let running = 0;
  const cumulative = allData.map(r => {
    running += r.cost;
    return running;
  });

  // Take the most recent slice that fits the terminal width.
  const data       = allData.slice(-(width * 2));
  const cumSlice   = cumulative.slice(-(width * 2));

  // If the slice has an odd length, start at index -1 so the very first char
  // uses only its right column, keeping the newest point flush to the right.
  const startIdx = -(data.length % 2);

  let line = "";
  for (let i = startIdx; i < data.length; i += 2) {
    const li = i >= 0              ? i     : null;
    const ri = i + 1 < data.length ? i + 1 : null;

    const leftNorm  = li !== null ? Math.min(cumSlice[li]!  / budget, 1) : 0;
    const rightNorm = ri !== null ? Math.min(cumSlice[ri]!  / budget, 1) : 0;

    const leftHeight  = Math.round(leftNorm  * 4);
    const rightHeight = Math.round(rightNorm * 4);

    const colorT = li !== null && ri !== null
      ? (leftNorm + rightNorm) / 2
      : li !== null ? leftNorm : rightNorm;

    line += burnColor(colorT) + brailleChar(leftHeight, rightHeight) + ANSI_RESET;
  }

  return line.length > 0 ? [line] : [];
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
      const ctx = r.contextTokens > 0 ? `  ${(r.contextTokens / 1000).toFixed(0)}k ctx` : "";
      lines.push(`  [${String(i + 1).padStart(2)}]  ${formatCost(r.cost)}${ctx}`);
    });
  }

  return lines.join("\n");
}

// ── Shared formatting ─────────────────────────────────────────────────────────

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
