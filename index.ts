/**
 * pi-burn
 *
 * Tracks cost per request over time, surfacing the acceleration in spend
 * as context grows. Think: meters per second per second, but for dollars.
 *
 * Status bar format:
 *   $0.0420  $0.013/req  +2.1x
 *   |         |            |
 *   total     recent avg   cost multiplier (how much more expensive
 *             per request  recent reqs are vs early ones)
 *
 * The multiplier only appears after 4+ requests (need enough data to
 * split into early vs recent halves meaningfully).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

type RequestRecord = {
  endTime: number; // ms epoch
  cost: number;    // USD
};

export default function (pi: ExtensionAPI) {
  let records: RequestRecord[] = [];
  let currentRequestCost = 0;
  let sessionStartTime = 0;

  // ── Session lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentRequestCost = 0;
    sessionStartTime = Date.now();

    // Reconstruct history from session branch so that reloads and resumes
    // don't wipe out accumulated data.
    records = reconstructFromBranch(ctx);

    const branch = ctx.sessionManager.getBranch();
    if (branch.length > 0 && branch[0].timestamp != null) {
      sessionStartTime = new Date(branch[0].timestamp as string | number).getTime();
    }

    updateStatus(ctx);
  });

  // ── Cost accumulation ────────────────────────────────────────────────────

  // Each assistant message within one agent run contributes to its cost.
  // Multiple messages per run occur when the model makes several tool-calling
  // turns before finishing.
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    const msg = event.message as AssistantMessage;
    currentRequestCost += msg.usage?.cost?.total ?? 0;
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (currentRequestCost > 0) {
      records.push({ endTime: Date.now(), cost: currentRequestCost });
    }
    currentRequestCost = 0;
    updateStatus(ctx);
  });

  // ── /burn command ────────────────────────────────────────────────────────

  pi.registerCommand("burn", {
    description: "Show cost burn rate details for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildDetailReport(), "info");
    },
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function reconstructFromBranch(ctx: ExtensionContext): RequestRecord[] {
    const result: RequestRecord[] = [];
    let runCost = 0;
    let runEndTime = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;

      const msg = entry.message;

      if (msg.role === "user") {
        // A new user message starts a new agent run. Flush the previous one.
        if (runCost > 0) {
          result.push({ endTime: runEndTime, cost: runCost });
          runCost = 0;
          runEndTime = 0;
        }
      } else if (msg.role === "assistant") {
        const m = msg as AssistantMessage;
        runCost += m.usage?.cost?.total ?? 0;
        runEndTime = new Date(entry.timestamp as string | number).getTime();
      }
    }

    // Do not flush the last in-progress run here. It will come in live via
    // message_end / agent_end events.

    return result;
  }

  function updateStatus(ctx: ExtensionContext) {
    const theme = ctx.ui.theme;

    if (records.length === 0 && currentRequestCost === 0) {
      ctx.ui.setStatus("burn", theme.fg("dim", "$0.000"));
      return;
    }

    const totalCost = records.reduce((s, r) => s + r.cost, 0) + currentRequestCost;
    const parts: string[] = [];

    parts.push(theme.fg("dim", `$${totalCost.toFixed(4)}`));

    if (records.length >= 1) {
      // Rolling average of the last 3 completed requests.
      const window = records.slice(-3);
      const windowAvg = window.reduce((s, r) => s + r.cost, 0) / window.length;
      parts.push(theme.fg("muted", `${formatCost(windowAvg)}/req`));
    }

    // Acceleration: compare the first half of completed requests against the
    // second half. Needs at least 4 data points to split meaningfully.
    if (records.length >= 4) {
      const mid = Math.floor(records.length / 2);
      const earlyAvg = records.slice(0, mid).reduce((s, r) => s + r.cost, 0) / mid;
      const recentAvg = records.slice(mid).reduce((s, r) => s + r.cost, 0) / (records.length - mid);
      const multiplier = earlyAvg > 0 ? recentAvg / earlyAvg : 1;

      if (multiplier > 1.05) {
        parts.push(theme.fg("warning", `+${multiplier.toFixed(1)}x`));
      } else if (multiplier < 0.95) {
        parts.push(theme.fg("success", `${multiplier.toFixed(1)}x`));
      }
      // Within 5% either way: no annotation; cost is stable.
    }

    ctx.ui.setStatus("burn", parts.join("  "));
  }

  function buildDetailReport(): string {
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
    ];

    if (records.length >= 2) {
      const first = records[0].cost;
      const last = records[records.length - 1].cost;
      const multiplier = first > 0 ? last / first : 1;
      lines.push(`First req:    ${formatCost(first)}`);
      lines.push(`Last req:     ${formatCost(last)}  (${multiplier.toFixed(2)}x first)`);
    }

    if (records.length >= 4) {
      lines.push("");
      lines.push("Per-request cost history:");
      records.forEach((r, i) => {
        lines.push(`  [${String(i + 1).padStart(2)}]  ${formatCost(r.cost)}`);
      });
    }

    return lines.join("\n");
  }

  function formatCost(usd: number): string {
    if (usd === 0) return "$0.000";
    if (usd >= 0.01) return `$${usd.toFixed(3)}`;
    if (usd >= 0.0001) return `${(usd * 100).toFixed(3)}¢`;
    return `${(usd * 100_000).toFixed(1)}μ¢`;
  }
}
