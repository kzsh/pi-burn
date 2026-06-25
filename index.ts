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
 *
 * Widget (above editor):
 *   Braille sparkline, left = oldest request, right = newest.
 *
 *   Bar HEIGHT: per-request cost relative to the session max. Tall = expensive
 *               relative to other requests in this session.
 *
 *   Bar COLOR:  input tokens / threshold. Green = small context, yellow =
 *               growing, red = at or over the threshold. The scale is absolute
 *               and never rescales as the session grows, so the graph drifts
 *               green → red over the course of a session as expected.
 *
 *   Default threshold: 150,000 tokens.
 *   Override with:     pi --burn-threshold 100000
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_THRESHOLD,
  buildDetailReport,
  buildStatusParts,
  formatCost,
  renderBurnGraph,
  type RequestRecord,
  type StatusStyle,
} from "./lib.ts";

// pi's theme color names that correspond to our StatusStyle values.
const THEME_COLOR: Record<StatusStyle, string> = {
  dim:     "dim",
  muted:   "muted",
  warning: "warning",
  success: "success",
};

export default function (pi: ExtensionAPI) {
  let records: RequestRecord[] = [];
  let currentRequestCost = 0;
  let currentContextTokens = 0;
  let threshold = DEFAULT_THRESHOLD;
  let sessionStartTime = 0;
  let widgetTui: { requestRender(): void } | null = null;

  pi.registerFlag("burn-threshold", {
    description: `Context token count treated as the 'bad' end of the color scale (default: ${DEFAULT_THRESHOLD})`,
    type: "string",
  });

  // ── Session lifecycle ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentRequestCost = 0;
    currentContextTokens = 0;
    sessionStartTime = Date.now();

    // CLI flags are not available during the factory; read them here instead.
    const flagVal = pi.getFlag("burn-threshold");
    if (typeof flagVal === "string" && flagVal) {
      const parsed = parseInt(flagVal, 10);
      if (!isNaN(parsed) && parsed > 0) threshold = parsed;
    }

    // Reconstruct history from session branch so that reloads and resumes
    // don't wipe out accumulated data.
    records = reconstructFromBranch(ctx);

    const branch = ctx.sessionManager.getBranch();
    if (branch.length > 0 && branch[0].timestamp != null) {
      sessionStartTime = new Date(branch[0].timestamp as string | number).getTime();
    }

    ctx.ui.setWidget("burn-graph", (tui, _theme) => {
      widgetTui = tui;
      return {
        render:    (width: number) => renderBurnGraph(records, currentRequestCost, currentContextTokens, threshold, width),
        invalidate: () => {},
      };
    });

    updateStatus(ctx);
  });

  // ── Cost accumulation ──────────────────────────────────────────────────────

  // Each assistant message within one agent run contributes to its cost.
  // Multiple messages per run occur when the model makes several tool-calling
  // turns before finishing.
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    const msg = event.message as AssistantMessage;
    currentRequestCost += msg.usage?.cost?.total ?? 0;
    // Always overwrite; later turns have larger context, so this ends up as the
    // maximum input-token count seen within the current run.
    currentContextTokens = msg.usage?.input ?? 0;
    // Refresh the graph live so the in-progress bar updates while streaming.
    widgetTui?.requestRender();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (currentRequestCost > 0) {
      records.push({
        endTime: Date.now(),
        cost: currentRequestCost,
        contextTokens: currentContextTokens,
      });
    }
    currentRequestCost = 0;
    currentContextTokens = 0;
    updateStatus(ctx);
    widgetTui?.requestRender();
  });

  // ── /burn command ──────────────────────────────────────────────────────────

  pi.registerCommand("burn", {
    description: "Show cost burn rate details for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildDetailReport(records, sessionStartTime, threshold), "info");
    },
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function reconstructFromBranch(ctx: ExtensionContext): RequestRecord[] {
    const result: RequestRecord[] = [];
    let runCost = 0;
    let runEndTime = 0;
    let runContextTokens = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;

      const msg = entry.message;

      if (msg.role === "user") {
        // A new user message starts a new agent run. Flush the previous one.
        if (runCost > 0) {
          result.push({ endTime: runEndTime, cost: runCost, contextTokens: runContextTokens });
          runCost = 0;
          runEndTime = 0;
          runContextTokens = 0;
        }
      } else if (msg.role === "assistant") {
        const m = msg as AssistantMessage;
        runCost += m.usage?.cost?.total ?? 0;
        runEndTime = new Date(entry.timestamp as string | number).getTime();
        // Overwrite so we keep the last (largest) context size for this run.
        runContextTokens = m.usage?.input ?? 0;
      }
    }

    // Do not flush the last in-progress run here. It will come in live via
    // message_end / agent_end events.

    return result;
  }

  function updateStatus(ctx: ExtensionContext) {
    const theme = ctx.ui.theme;
    const parts = buildStatusParts(records, currentRequestCost);
    ctx.ui.setStatus(
      "burn",
      parts.map(p => theme.fg(THEME_COLOR[p.style], p.text)).join("  "),
    );
  }

  // formatCost is exported from lib.ts and used in buildDetailReport, but the
  // extension also needs it for nothing currently — keep the import tidy.
  void formatCost;
}
