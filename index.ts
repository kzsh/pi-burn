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
 *   Two-row braille sparkline, left = oldest request, right = newest.
 *
 *   Bar HEIGHT: total tokens (input + output + cache_write + cache_hit) for
 *               that request, scaled to the session max across the visible
 *               window.  Two rows of braille = 8 dot levels of resolution.
 *
 *   Bar COLOR:  stacked by token type, bottom → top:
 *               cyan  = cache_hit   (cheapest per token)
 *               green = input
 *               amber = cache_write
 *               orange = output     (most expensive per token)
 */

import { appendFileSync } from "fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_BUDGET,
  buildDetailReport,
  buildStatusParts,
  renderBurnGraph,
  type GraphDebug,
  type RequestRecord,
  type StatusStyle,
} from "./lib.ts";

const PI_BURN_DEBUG = !!process.env["PI_BURN_DEBUG"];
const DEBUG_LOG     = "/tmp/pi-burn-graph.log";

// pi's theme color names that correspond to our StatusStyle values.
const THEME_COLOR: Record<StatusStyle, string> = {
  dim:     "dim",
  muted:   "muted",
  warning: "warning",
  success: "success",
};

export default function (pi: ExtensionAPI) {
  let records: RequestRecord[] = [];
  let currentRequestCost    = 0;
  let currentInputTokens    = 0;
  let currentOutputTokens   = 0;
  let currentCacheWriteTokens = 0;
  let currentCacheHitTokens   = 0;
  let budget = DEFAULT_BUDGET;
  let sessionStartTime = 0;
  let widgetTui: { requestRender(): void } | null = null;
  let lastGraphDebug: GraphDebug | null = null;

  pi.registerFlag("burn-budget", {
    description: `Session spend limit in dollars at which the graph turns fully red (default: $${DEFAULT_BUDGET})`,
    type: "string",
  });

  // ── Session lifecycle ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentRequestCost      = 0;
    currentInputTokens      = 0;
    currentOutputTokens     = 0;
    currentCacheWriteTokens = 0;
    currentCacheHitTokens   = 0;
    sessionStartTime = Date.now();

    // CLI flags are not available during the factory; read them here instead.
    const flagVal = pi.getFlag("burn-budget");
    if (typeof flagVal === "string" && flagVal) {
      const parsed = parseFloat(flagVal);
      if (!isNaN(parsed) && parsed > 0) budget = parsed;
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
        render: (width: number) => {
          const live: RequestRecord | null = (currentRequestCost > 0 || currentInputTokens > 0)
            ? {
                endTime:          Date.now(),
                cost:             currentRequestCost,
                        inputTokens:      currentInputTokens,
                outputTokens:     currentOutputTokens,
                cacheWriteTokens: currentCacheWriteTokens,
                cacheHitTokens:   currentCacheHitTokens,
              }
            : null;
          return renderBurnGraph(records, live, width, PI_BURN_DEBUG ? (d) => {
            lastGraphDebug = d;
            appendFileSync(DEBUG_LOG, formatGraphDebug(d));
          } : undefined);
        },
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
    currentRequestCost      += msg.usage?.cost?.total ?? 0;
    // Input/cacheHit/cacheWrite are overwritten: later turns have the full
    // accumulated context, so the last value is always the largest.
    currentInputTokens       = msg.usage?.input       ?? 0;
    currentCacheHitTokens    = msg.usage?.cacheRead   ?? 0;
    currentCacheWriteTokens  = msg.usage?.cacheWrite  ?? 0;
    // Output accumulates across turns within one run.
    currentOutputTokens     += msg.usage?.output      ?? 0;
    // Refresh the graph live so the in-progress bar updates while streaming.
    widgetTui?.requestRender();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (currentRequestCost > 0 || currentInputTokens > 0) {
      records.push({
        endTime:          Date.now(),
        cost:             currentRequestCost,
        inputTokens:      currentInputTokens,
        outputTokens:     currentOutputTokens,
        cacheWriteTokens: currentCacheWriteTokens,
        cacheHitTokens:   currentCacheHitTokens,
      });
    }
    currentRequestCost      = 0;
    currentInputTokens      = 0;
    currentOutputTokens     = 0;
    currentCacheWriteTokens = 0;
    currentCacheHitTokens   = 0;
    updateStatus(ctx);
    widgetTui?.requestRender();
  });

  // ── /burn command ──────────────────────────────────────────────────────────

  if (PI_BURN_DEBUG) {
    pi.registerCommand("burn-debug", {
      description: "Print current graph render values (requires PI_BURN_DEBUG env var)",
      handler: async (_args, ctx) => {
        if (!lastGraphDebug) {
          ctx.ui.notify("No graph data rendered yet.", "info");
          return;
        }
        ctx.ui.notify(formatGraphDebug(lastGraphDebug), "info");
      },
    });
  }

  pi.registerCommand("burn", {
    description: "Show cost burn rate details for this session",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildDetailReport(records, sessionStartTime, budget), "info");
    },
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function reconstructFromBranch(ctx: ExtensionContext): RequestRecord[] {
    const result: RequestRecord[] = [];
    let runCost             = 0;
    let runEndTime          = 0;
    let runInput            = 0;
    let runOutput           = 0;
    let runCacheWrite       = 0;
    let runCacheHit         = 0;

    function flushRun() {
      if (runCost > 0 || runInput > 0) {
        result.push({
          endTime:          runEndTime,
          cost:             runCost,
          inputTokens:      runInput,
          outputTokens:     runOutput,
          cacheWriteTokens: runCacheWrite,
          cacheHitTokens:   runCacheHit,
        });
      }
      runCost = 0; runEndTime = 0;
      runInput = 0; runOutput = 0; runCacheWrite = 0; runCacheHit = 0;
    }

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;

      const msg = entry.message;

      if (msg.role === "user") {
        flushRun();
      } else if (msg.role === "assistant") {
        const m = msg as AssistantMessage;
        runCost      += m.usage?.cost?.total ?? 0;
        runEndTime    = new Date(entry.timestamp as string | number).getTime();
        // Overwrite: later turns have the full accumulated context.
        runInput      = m.usage?.input       ?? 0;
        runCacheHit   = m.usage?.cacheRead   ?? 0;
        runCacheWrite = m.usage?.cacheWrite   ?? 0;
        // Output accumulates.
        runOutput    += m.usage?.output      ?? 0;
      }
    }

    // Everything in the branch is committed history. Flush the last run so
    // it appears in the graph on resume.
    flushRun();

    return result;
  }

  function formatGraphDebug(d: GraphDebug): string {
    const head = [
      `=== ${d.timestamp} ===`,
      `maxTotal: ${d.maxTotal}  scale: ${d.scale.toExponential(3)}  bars: ${d.bars.length}`,
      ` #   total    hit      input    write    output   dots  b  t`,
    ].join("\n");
    const rows = d.bars.map((b, i) =>
      [
        String(i).padStart(2),
        String(b.total).padStart(7),
        String(b.cacheHit).padStart(7),
        String(b.input).padStart(7),
        String(b.cacheWrite).padStart(7),
        String(b.output).padStart(7),
        String(b.dots).padStart(5),
        String(b.botDots).padStart(2),
        String(b.topDots).padStart(2),
      ].join("  ")
    ).join("\n");
    return head + "\n" + rows + "\n\n";
  }

  function updateStatus(ctx: ExtensionContext) {
    const theme = ctx.ui.theme;
    const parts = buildStatusParts(records);
    ctx.ui.setStatus(
      "burn",
      parts.map(p => theme.fg(THEME_COLOR[p.style], p.text)).join("  "),
    );
  }

}
