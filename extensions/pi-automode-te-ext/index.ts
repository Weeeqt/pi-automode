import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CLASSIFIER_BLOCK_EVENT,
  type ClassifierBlockAnswer,
  type ClassifierBlockRequest,
} from "../auto-mode/te-ext-hook.ts";
import {
  isOperationalFailure,
  isRetryable,
  operationalFailureMessage,
  retryDelayMs,
  waitForRetry,
} from "./retry.ts";
import {
  choiceFromLabel,
  reviewOptions,
  reviewRequestFromResult,
  showReview,
  type ReviewRequest,
} from "./review.ts";

/**
 * pi-automode-te-ext: classifier retry + review UI for pi-automode.
 *
 * Handles `pi-automode:classifier-block`, emitted by pi-automode after every
 * non-allow classifier result:
 *
 * 1. Retryable operational failure -> wait (2s, 5s, 10s x10, 30s...) and retry.
 *    Esc aborts the turn signal and stops retrying.
 * 2. Other operational failure (or retry stopped) -> deny with an
 *    operational-failure message for the main model. No review dialog.
 * 3. Real classifier verdict -> review dialog when UI exists, else deny.
 *
 * Never runs tools and never calls a model.
 */

const STATUS_KEY = "pi-automode-te-ext";

function isRequest(value: unknown): value is ClassifierBlockRequest {
  const r = value as ClassifierBlockRequest | undefined;
  return !!r && typeof r.respond === "function" && typeof r.attempt === "number" &&
    typeof r.toolCallId === "string" && typeof r.result?.decision === "string";
}

type Pending = { toolName: string; attempt: number; dueAt: number };

export default function piAutomodeTeExt(pi: ExtensionAPI) {
  let currentContext: ExtensionContext | undefined;
  // Calls waiting for a retry, keyed by tool call ID; parallel calls retry independently.
  const pending = new Map<string, Pending>();
  const stopWaiting = new AbortController();
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const renderStatus = () => {
    const ctx = currentContext;
    if (!ctx?.hasUI) return;
    if (pending.size === 0) return ctx.ui.setStatus(STATUS_KEY, undefined);
    const next = [...pending.values()].sort((a, b) => a.dueAt - b.dueAt)[0];
    const seconds = Math.max(0, Math.ceil((next.dueAt - Date.now()) / 1000));
    const calls = pending.size === 1 ? next.toolName : `${pending.size} calls`;
    ctx.ui.setStatus(STATUS_KEY, `classifier unavailable: retry #${next.attempt} (${calls}) in ${seconds}s, Esc to stop`);
  };
  const syncStatus = () => {
    if (pending.size > 0 && !statusTimer) statusTimer = setInterval(renderStatus, 1_000);
    if (pending.size === 0 && statusTimer) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
    renderStatus();
  };

  async function retryAnswer(request: ClassifierBlockRequest, signal: AbortSignal): Promise<ClassifierBlockAnswer> {
    const delay = retryDelayMs(request.attempt);
    pending.set(request.toolCallId, { toolName: request.toolName, attempt: request.attempt, dueAt: Date.now() + delay });
    syncStatus();
    const combined = AbortSignal.any([signal, stopWaiting.signal]);
    const outcome = await waitForRetry(delay, combined);
    pending.delete(request.toolCallId);
    syncStatus();
    return outcome === "retry"
      ? { action: "retry" }
      : { action: "deny", message: operationalFailureMessage(request.result.reason) };
  }

  async function reviewAnswer(ctx: ExtensionContext, review: ReviewRequest): Promise<ClassifierBlockAnswer> {
    try {
      const options = reviewOptions(review);
      return { action: choiceFromLabel(await showReview(ctx, review, options), options) };
    } catch (error) {
      ctx.ui.notify(
        `Auto-mode review failed; action denied: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return { action: "deny" };
    }
  }

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
  });

  pi.on("session_shutdown", () => {
    stopWaiting.abort();
    pending.clear();
    syncStatus();
    currentContext = undefined;
  });

  pi.events.on(CLASSIFIER_BLOCK_EVENT, (value) => {
    if (!isRequest(value)) return;
    const request = value;
    const { result, signal } = request;
    const ctx = currentContext;

    // Operational failures: retry while interruptible, else explain to the model.
    if (isOperationalFailure(result)) {
      request.handled = true;
      if (signal && !signal.aborted && isRetryable(result)) {
        void retryAnswer(request, signal).then(request.respond);
      } else {
        request.respond({ action: "deny", message: operationalFailureMessage(result.reason) });
      }
      return;
    }

    // Real verdicts: review dialog when a UI exists; otherwise stock deny.
    if (!ctx?.hasUI) return;
    request.handled = true;
    void reviewAnswer(ctx, reviewRequestFromResult(request.toolName, request.action, result)).then(request.respond);
  });

  pi.registerCommand("automode-review-test", {
    description: "Open a synthetic auto-mode review dialog; no tool call is created or executed",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "failure") {
        ctx.ui.notify(
          "Synthetic operational failure: no review dialog opened and nothing was executed. In real use, retryable failures are retried and the rest are reported to the main model.",
          "warning",
        );
        return;
      }
      const hard = mode === "hard";
      const tier = hard ? "hard_deny" : "soft_deny";
      const review: ReviewRequest = {
        toolName: "bash (synthetic test only)",
        action: 'bash {"command":"printf synthetic-review-test"}',
        reason: hard
          ? "Synthetic classifier hard-deny used only to verify that Allow once is hidden."
          : "Synthetic soft-deny used only to test the review dialog. No tool call exists behind this prompt.",
        kind: "classifier",
        classifierTier: tier,
        failure: false,
        classifier: {
          decision: "block",
          tier,
          reason: "Synthetic classifier explanation.",
          model: "synthetic/test-model",
          attempts: [{
            stage: "detailed",
            attempt: 1,
            durationMs: 42,
            response: { stopReason: "toolUse", text: "", model: "synthetic/test-model" },
            parsed: { decision: "block", tier, reason: `Synthetic ${tier} explanation.` },
          }],
        },
      };
      const answer = await reviewAnswer(ctx, review);
      ctx.ui.notify(
        `Synthetic review result: ${answer.action}. Nothing was executed${
          answer.action === "disable-and-deny" ? "; auto mode was not changed by this synthetic test" : ""
        }.`,
        answer.action === "allow-once" ? "info" : "warning",
      );
    },
  });
}
