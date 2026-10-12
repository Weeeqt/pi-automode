import type { ClassifyResult } from "../auto-mode/types.ts";

/** Delay before retry `attempt` (1-based): 2s, 5s, 10s x10, then 30s forever. */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 1) return 2_000;
  if (attempt === 2) return 5_000;
  if (attempt <= 12) return 10_000;
  return 30_000;
}

/**
 * True when the classifier never produced a decision, so the block is an
 * operational failure rather than a safety judgment. Decided from structured
 * classifier I/O, never from reason text.
 */
export function isOperationalFailure(result: ClassifyResult): boolean {
  if (result.decision !== "block") return false;
  return !(result.io?.attempts.some((attempt) => attempt.parsed !== undefined) ?? false);
}

/**
 * Operational failures that can succeed on a later attempt.
 *
 * - No `io`: no classifier model/API key resolved (can be temporary with proxies).
 * - Otherwise the last attempt decides:
 *   - request threw (network, timeout, auth): retry;
 *   - provider stopReason error / aborted / length: retry;
 *   - detailed stage without a parsed decision (missing/invalid tool call): retry;
 *   - fast stage output other than "0"/"1" (malformed): retry;
 *   - fast stage "1" with no detailed attempt: the detailed request exceeded
 *     the context window before it was sent. Deterministic, not retried.
 * - `io` with no attempts: the fast request exceeded the context window. Not retried.
 */
export function isRetryable(result: ClassifyResult): boolean {
  if (!isOperationalFailure(result)) return false;
  if (!result.io) return true;
  const last = result.io.attempts.at(-1);
  if (!last) return false;
  if (last.error !== undefined) return true;
  const stopReason = last.response?.stopReason;
  if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") return true;
  if (last.stage === "detailed") return true;
  const text = last.response?.text.trim();
  return text !== "0" && text !== "1";
}

/** Model-facing block text for an operational failure (replaces the generic block text). */
export function operationalFailureMessage(reason: string): string {
  return `[pi-automode] Action not executed because the safety classifier was unavailable or returned an invalid response. This is an operational classifier failure, not a semantic judgment that the action is unsafe. ${reason} Report the temporary classifier failure to the user; do not claim the tool ran or rely on its effects.`;
}

/** Resolve "retry" after the delay, or "stop" as soon as `signal` aborts. */
export function waitForRetry(delayMs: number, signal: AbortSignal): Promise<"retry" | "stop"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("stop");
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("retry");
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve("stop");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
