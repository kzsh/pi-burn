/**
 * pi-burn core logic — no pi dependencies, fully testable standalone.
 */

export const DEFAULT_THRESHOLD = 150_000;

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

// t=0 => green (0,200,0), t=0.5 => yellow (220,200,0), t=1 => red (220,0,0)
export function burnColor(t: number): string {
  const r = Math.round(Math.min(1, t * 2) * 220);
  const g = Math.round(Math.min(1, (1 - t) * 2) * 200);
  return `\x1b[38;2;${r};${g};0m`;
}

const ANSI_RESET = "\x1b[0m";

// ── Graph ─────────────────────────────────────────────────────────────────────

export function renderBurnGraph(
  records: RequestRecord[],
  currentRequestCost: number,
  currentContextTokens: number,
  threshold: number,
  width: number,
): string[] {
  // Append in-progress request as a live bar at the right edge.
  const allData: RequestRecord[] = currentRequestCost > 0
    ? [...records, { endTime: Date.now(), cost: currentRequestCost, contextTokens: currentContextTokens }]
    : records;

  if (allData.length === 0) return [];

  // Height: cost relative to session max (shows which requests were pricey).
  const maxCost = Math.max(...allData.map(r => r.cost));
  if (maxCost === 0) return [];

  // Each braille char encodes 2 data columns; take the most recent slice that
  // fits the available terminal width.
  const data = allData.slice(-(width * 2));

  // If the slice has an odd length, start at index -1 so the very first char
  // uses only its right column, keeping the newest point flush to the right.
  const startIdx = -(data.length % 2);

  let line = "";
  for (let i = startIdx; i < data.length; i += 2) {
    const left  = i >= 0              ? data[i]     : null;
    const right = i + 1 < data.length ? data[i + 1] : null;

    // Height from relative cost.
    const leftCostNorm  = left  ? left.cost  / maxCost : 0;
    const rightCostNorm = right ? right.cost / maxCost : 0;
    const leftHeight  = Math.round(leftCostNorm  * 4);
    const rightHeight = Math.round(rightCostNorm * 4);

    // Color from absolute context size — never rescales as the session grows.
    const leftColorT  = left  ? Math.min(left.contextTokens  / threshold, 1) : 0;
    const rightColorT = right ? Math.min(right.contextTokens / threshold, 1) : 0;
    const colorT = left && right
      ? (leftColorT + rightColorT) / 2
      : left ? leftColorT : rightColorT;

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
export function buildStatusParts(
  records: RequestRecord[],
  currentRequestCost: number,
): StatusPart[] {
  if (records.length === 0 && currentRequestCost === 0) {
    return [{ text: "$0.000", style: "dim" }];
  }

  const totalCost = records.reduce((s, r) => s + r.cost, 0) + currentRequestCost;
  const parts: StatusPart[] = [];

  parts.push({ text: `$${totalCost.toFixed(4)}`, style: "dim" });

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
  threshold: number,
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
    `Threshold:    ${threshold.toLocaleString()} tokens`,
  ];

  if (records.length >= 2) {
    const first = records[0].cost;
    const last  = records[records.length - 1].cost;
    const multiplier = first > 0 ? last / first : 1;
    lines.push(`First req:    ${formatCost(first)}`);
    lines.push(`Last req:     ${formatCost(last)}  (${multiplier.toFixed(2)}x first)`);
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
  if (usd === 0) return "$0.000";
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd >= 0.0001) return `${(usd * 100).toFixed(3)}¢`;
  return `${(usd * 100_000).toFixed(1)}μ¢`;
}
