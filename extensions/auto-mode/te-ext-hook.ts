/**
 * [pi-automode-te-ext] Optional decision hook for non-allow classifier results.
 *
 * pi-automode emits `pi-automode:classifier-block` after every classifier
 * result that is not an allow. A listener (pi-automode-te-ext) may retry the
 * classification, release the call once after user review, or deny with its
 * own model-facing message. All policy lives in the listener. This file only
 * carries facts out and enforces two safety rules:
 *
 * - Without a listener, the result is a plain deny (stock behavior).
 * - `allow-once` is accepted only for a real classifier verdict (a parsed
 *   decision) that is not `hard_deny`. Anything else degrades to `deny`.
 */
import type { ClassifyResult } from "./types.ts";

export const CLASSIFIER_BLOCK_EVENT = "pi-automode:classifier-block";

export type ClassifierBlockAnswer =
  | { action: "retry" }
  | { action: "allow-once" }
  | { action: "deny"; message?: string }
  | { action: "disable-and-deny"; message?: string };

export type ClassifierBlockRequest = {
  toolName: string;
  toolCallId: string;
  /** pi-automode action summary. */
  action: string;
  /** Snapshot of the classifier result, including `io` when available. */
  result: ClassifyResult;
  /** False when no classifier model/API key resolved (`result.io` absent). */
  resolved: boolean;
  /** True when any classifier attempt produced a parsed decision. */
  verdict: boolean;
  /** 1-based count of classifications for this tool call. */
  attempt: number;
  signal: AbortSignal | undefined;
  /** Listener must set this synchronously before returning. */
  handled: boolean;
  respond: (answer: ClassifierBlockAnswer) => void;
};

type Emit = (event: string, data: unknown) => void;

export function isClassifierVerdict(result: ClassifyResult): boolean {
  return result.io?.attempts.some((attempt) => attempt.parsed !== undefined) ?? false;
}

/** Ask an optional listener what to do with a non-allow classifier result. */
export function requestClassifierBlockDecision(
  emit: Emit,
  facts: Omit<ClassifierBlockRequest, "resolved" | "verdict" | "handled" | "respond">,
): Promise<ClassifierBlockAnswer> {
  const verdict = isClassifierVerdict(facts.result);
  const allowOnceAllowed = verdict && facts.result.tier !== "hard_deny";
  return new Promise<ClassifierBlockAnswer>((resolve) => {
    let settled = false;
    const request: ClassifierBlockRequest = {
      ...facts,
      // Snapshot so listener mutations cannot change pi-automode's decision.
      result: structuredClone(facts.result),
      resolved: facts.result.io !== undefined,
      verdict,
      handled: false,
      respond: (answer) => {
        if (settled) return;
        settled = true;
        resolve(
          answer?.action === "allow-once" && !allowOnceAllowed
            ? { action: "deny" }
            : answer ?? { action: "deny" },
        );
      },
    };
    emit(CLASSIFIER_BLOCK_EVENT, request);
    if (!request.handled) request.respond({ action: "deny" });
  });
}
