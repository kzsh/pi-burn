/**
 * pi-burn
 *
 * Tracks cost per request over time, surfacing the acceleration in spend
 * as context grows. Think: meters per second per second, but for dollars.
 *
 * Status bar:
 *   $0.013/req  cr:$0.001  in:$0.011  cw:$0.000  out:$0.001  +2.1x
 *   |            |                                             |
 *   recent avg   per-type cost breakdown (3-req window)       cost multiplier
 *
 * The multiplier only appears after 4+ requests (need enough data to
 * split into early vs recent halves meaningfully).
 *
 * Widget (above editor):
 *   One sparkline row per cost type (cr/in/cw/out), each showing that
 *   type's cost across round trips on a shared scale.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, SettingsList } from "@earendil-works/pi-tui";
import {
  DEFAULT_BUDGET,
  buildDetailReport,
  buildStatusParts,
  renderCostGraph,
  type RequestRecord,
  type StatusStyle,
} from "./lib.ts";

// pi's theme color names that correspond to our StatusStyle values.
// "raw" parts carry their own ANSI codes and bypass theme wrapping.
const THEME_COLOR: Record<Exclude<StatusStyle, "raw">, string> = {
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
  let currentInputCost      = 0;
  let currentOutputCost     = 0;
  let currentCacheReadCost  = 0;
  let currentCacheWriteCost = 0;
  let budget = DEFAULT_BUDGET;
  let sessionStartTime = 0;
  let widgetTui: { requestRender(): void } | null = null;

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
    currentInputCost      = 0;
    currentOutputCost     = 0;
    currentCacheReadCost  = 0;
    currentCacheWriteCost = 0;
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
                inputCost:        currentInputCost,
                outputCost:       currentOutputCost,
                cacheReadCost:    currentCacheReadCost,
                cacheWriteCost:   currentCacheWriteCost,
              }
            : null;
          return renderCostGraph(records, live, width);
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
    currentRequestCost      += msg.usage?.cost?.total     ?? 0;
    // Input/cacheHit/cacheWrite tokens are overwritten: later turns have the
    // full accumulated context, so the last value is always the largest.
    currentInputTokens       = msg.usage?.input            ?? 0;
    currentCacheHitTokens    = msg.usage?.cacheRead        ?? 0;
    currentCacheWriteTokens  = msg.usage?.cacheWrite       ?? 0;
    // Output tokens accumulate across turns within one run.
    currentOutputTokens     += msg.usage?.output           ?? 0;
    // Per-type costs are all accumulated: every turn pays for its own
    // input/output/cache, so summing gives the true per-category total.
    currentInputCost        += msg.usage?.cost?.input      ?? 0;
    currentOutputCost       += msg.usage?.cost?.output     ?? 0;
    currentCacheReadCost    += msg.usage?.cost?.cacheRead  ?? 0;
    currentCacheWriteCost   += msg.usage?.cost?.cacheWrite ?? 0;
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
        inputCost:        currentInputCost,
        outputCost:       currentOutputCost,
        cacheReadCost:    currentCacheReadCost,
        cacheWriteCost:   currentCacheWriteCost,
      });
    }
    currentRequestCost      = 0;
    currentInputTokens      = 0;
    currentOutputTokens     = 0;
    currentCacheWriteTokens = 0;
    currentCacheHitTokens   = 0;
    currentInputCost      = 0;
    currentOutputCost     = 0;
    currentCacheReadCost  = 0;
    currentCacheWriteCost = 0;
    updateStatus(ctx);
    widgetTui?.requestRender();
  });

  // ── /burn command ──────────────────────────────────────────────────────────

  pi.registerCommand("burn", {
    description: "Show cost burn rate details and settings for this session",
    handler: async (args, ctx) => {
      // /burn report → full detail report
      if (args?.trim() === "report" || ctx.mode !== "tui") {
        ctx.ui.notify(buildDetailReport(records, sessionStartTime, budget), "info");
        return;
      }

      const items = [];

      await ctx.ui.custom((tui, theme, _kb, done) => {
        const header = new (class {
          render(_width: number) {
            return [theme.fg("accent", theme.bold("Burn")), ""];
          }
          invalidate() {}
        })();

        const settingsList = new SettingsList(
          items,
          items.length + 2,
          getSettingsListTheme(),
          (_id, _newValue) => {},
          () => done(undefined),
        );

        const container = new Container();
        container.addChild(header);
        container.addChild(settingsList);

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            settingsList.handleInput?.(data);
            tui.requestRender();
          },
        };
      });
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
    let runInputCost        = 0;
    let runOutputCost       = 0;
    let runCacheReadCost    = 0;
    let runCacheWriteCost   = 0;

    function flushRun() {
      if (runCost > 0 || runInput > 0) {
        result.push({
          endTime:          runEndTime,
          cost:             runCost,
          inputTokens:      runInput,
          outputTokens:     runOutput,
          cacheWriteTokens: runCacheWrite,
          cacheHitTokens:   runCacheHit,
          inputCost:        runInputCost,
          outputCost:       runOutputCost,
          cacheReadCost:    runCacheReadCost,
          cacheWriteCost:   runCacheWriteCost,
        });
      }
      runCost = 0; runEndTime = 0;
      runInput = 0; runOutput = 0; runCacheWrite = 0; runCacheHit = 0;
      runInputCost = 0; runOutputCost = 0; runCacheReadCost = 0; runCacheWriteCost = 0;
    }

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;

      const msg = entry.message;

      if (msg.role === "user") {
        flushRun();
      } else if (msg.role === "assistant") {
        const m = msg as AssistantMessage;
        runCost          += m.usage?.cost?.total     ?? 0;
        runEndTime        = new Date(entry.timestamp as string | number).getTime();
        // Overwrite: later turns have the full accumulated context.
        runInput          = m.usage?.input            ?? 0;
        runCacheHit       = m.usage?.cacheRead        ?? 0;
        runCacheWrite     = m.usage?.cacheWrite       ?? 0;
        // Output and all per-type costs accumulate across turns.
        runOutput        += m.usage?.output           ?? 0;
        runInputCost     += m.usage?.cost?.input      ?? 0;
        runOutputCost    += m.usage?.cost?.output     ?? 0;
        runCacheReadCost += m.usage?.cost?.cacheRead  ?? 0;
        runCacheWriteCost+= m.usage?.cost?.cacheWrite ?? 0;
      }
    }

    // Everything in the branch is committed history. Flush the last run so
    // it appears in the graph on resume.
    flushRun();

    return result;
  }

  function updateStatus(ctx: ExtensionContext) {
    const theme = ctx.ui.theme;
    const parts = buildStatusParts(records);
    ctx.ui.setStatus(
      "burn",
      parts.map(p =>
        p.style === "raw" ? p.text : theme.fg(THEME_COLOR[p.style], p.text)
      ).join("  "),
    );
  }

}
