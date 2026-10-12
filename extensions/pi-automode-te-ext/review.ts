import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ClassifyResult } from "../auto-mode/types.ts";
import { isOperationalFailure } from "./retry.ts";

/**
 * Review dialog for classifier blocks. Ported from pi-automode-review.
 * Operational failure is decided structurally (no parsed classifier decision),
 * not from the reason text.
 */

export type ReviewChoice = "allow-once" | "deny" | "disable-and-deny";

type ClassifierAttempt = {
  stage?: string;
  attempt?: number;
  durationMs?: number;
  error?: string;
  parsed?: { decision?: string; tier?: string; reason?: string };
  response?: {
    stopReason?: string;
    text?: string;
    errorMessage?: string;
    model?: string;
    toolCalls?: Array<{ name?: string; arguments?: string }>;
  };
};

/** Display data for one review. */
export type ReviewRequest = {
  toolName: string;
  action: string;
  reason: string;
  kind: string;
  classifierTier?: string;
  /** True when the classifier never produced a decision. */
  failure: boolean;
  classifier?: {
    decision?: string;
    tier?: string;
    reason?: string;
    model?: string;
    attempts?: ClassifierAttempt[];
  };
};

export function reviewRequestFromResult(toolName: string, action: string, result: ClassifyResult): ReviewRequest {
  return {
    toolName,
    action,
    reason: result.reason,
    kind: "classifier",
    classifierTier: result.tier,
    failure: isOperationalFailure(result),
    classifier: {
      decision: result.decision,
      tier: result.tier,
      reason: result.reason,
      model: result.io?.model,
      attempts: result.io?.attempts.map((attempt) => ({
        stage: attempt.stage,
        attempt: attempt.attempt,
        durationMs: attempt.durationMs,
        error: attempt.error,
        parsed: attempt.parsed,
        response: attempt.response
          ? {
            stopReason: attempt.response.stopReason,
            text: attempt.response.text,
            errorMessage: attempt.response.errorMessage,
            model: attempt.response.model,
            toolCalls: attempt.response.toolCalls?.slice(0, 5).map((call) => ({
              name: call.name,
              arguments: safeStringify(call.arguments),
            })),
          }
          : undefined,
      })),
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Options offered for a request. Allow once only for real, non-hard-deny verdicts. */
export function reviewOptions(request: ReviewRequest): string[] {
  const canAllow = !request.failure && request.classifierTier !== "hard_deny";
  return canAllow
    ? ["Allow once", "Deny", "Disable auto mode and deny"]
    : ["Deny", "Disable auto mode and deny"];
}

export function choiceFromLabel(label: string | undefined, options: string[]): ReviewChoice {
  if (label === "Allow once" && options.includes("Allow once")) return "allow-once";
  if (label === "Disable auto mode and deny") return "disable-and-deny";
  return "deny";
}

const MAX_ACTION_LENGTH = 2400;
const MAX_REASON_LENGTH = 1800;
const MAX_DETAIL_LENGTH = 1200;

function clip(value: string | undefined, max: number): string {
  if (!value) return "(none)";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 40)}\n… [truncated]`;
}

function classificationLabel(request: ReviewRequest): string {
  if (request.failure) return `${request.kind} / protocol failure`;
  return `${request.kind}${request.classifierTier ? ` / ${request.classifierTier}` : ""}`;
}

function displayAction(request: ReviewRequest): string {
  const objectStart = request.action.indexOf("{");
  if (objectStart >= 0) {
    try {
      const input = JSON.parse(request.action.slice(objectStart)) as { command?: unknown; path?: unknown };
      if (typeof input.command === "string") return input.command;
      if (typeof input.path === "string") return input.path;
    } catch {
      // Keep the original summary when it is not standalone JSON.
    }
  }
  return request.action;
}

function attemptDetails(attempt: ClassifierAttempt): string[] {
  const response = attempt.response;
  const lines = [
    `${attempt.stage ?? "stage"} attempt ${attempt.attempt ?? "?"} · ${attempt.durationMs ?? "?"} ms`,
  ];
  if (attempt.error) lines.push(`Error: ${clip(attempt.error, MAX_DETAIL_LENGTH)}`);
  if (response) {
    lines.push(`Stop reason: ${response.stopReason ?? "unknown"}`);
    if (response.model) lines.push(`Response model: ${response.model}`);
    if (response.errorMessage) lines.push(`Provider error: ${clip(response.errorMessage, MAX_DETAIL_LENGTH)}`);
    if (response.text?.trim()) lines.push(`Text: ${clip(response.text.trim(), MAX_DETAIL_LENGTH)}`);
    else lines.push("Text: (empty)");
    for (const call of response.toolCalls ?? []) {
      lines.push(
        `Tool call: ${call.name ?? "unknown"}`,
        `Arguments: ${clip(call.arguments, MAX_DETAIL_LENGTH)}`,
      );
    }
  }
  if (attempt.parsed) {
    lines.push(`Parsed: ${attempt.parsed.decision ?? "?"} / ${attempt.parsed.tier ?? "?"}`);
    if (attempt.parsed.reason) lines.push(`Parsed reason: ${clip(attempt.parsed.reason, MAX_DETAIL_LENGTH)}`);
  }
  return lines;
}

function plainReviewTitle(request: ReviewRequest, showDetails: boolean): string {
  const attempts = request.classifier?.attempts ?? [];
  const failure = request.failure;
  return [
    `Auto-mode review · ${request.toolName} · ${classificationLabel(request)}`,
    request.classifier?.model ? `Model: ${request.classifier.model}` : "",
    `Action: ${clip(displayAction(request), MAX_ACTION_LENGTH)}`,
    `${failure ? "Fail-closed reason" : "Reason"}: ${clip(request.reason, MAX_REASON_LENGTH)}`,
    ...(showDetails && attempts.length
      ? ["", "Classifier details:", ...attempts.flatMap(attemptDetails)]
      : []),
  ].filter((line) => line !== "").join("\n");
}

const SHOW_DETAILS = "Show classifier details";
const HIDE_DETAILS = "Hide classifier details";

export async function showReview(
  ctx: ExtensionContext,
  request: ReviewRequest,
  options: string[],
): Promise<string | undefined> {
  const attempts = request.classifier?.attempts ?? [];

  if (ctx.mode !== "tui") {
    // Non-TUI fallback: offer the details toggle as an extra select entry.
    let showDetails = false;
    while (true) {
      const entries = attempts.length ? [...options, showDetails ? HIDE_DETAILS : SHOW_DETAILS] : options;
      const choice = await ctx.ui.select(plainReviewTitle(request, showDetails), entries);
      if (choice === SHOW_DETAILS || choice === HIDE_DETAILS) {
        showDetails = !showDetails;
        continue;
      }
      return choice;
    }
  }

  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    let selected = 0;
    let expanded = false;
    // Line indexes of interactive rows, recorded on each render for mouse hit-testing.
    let toggleRow = -1;
    let buttonRow = -1;
    let buttonSpans: Array<{ start: number; end: number }> = [];
    let buttonsVertical = false;

    const failure = request.failure;
    const severity = request.classifierTier === "hard_deny" || failure ? "error" : "warning";

    const toggleDetails = () => {
      expanded = !expanded;
      tui.requestRender();
    };

    const component = {
      render(width: number): string[] {
        const w = Math.max(20, width);
        const lines: string[] = [];
        const fit = (line: string) => truncateToWidth(line, w);

        // Header: title, tool and classification on one rule line.
        const title = theme.bold(theme.fg("warning", " Auto-mode review "));
        const meta = `${theme.fg("text", request.toolName)}${theme.fg("dim", " · ")}${
          theme.bold(theme.fg(severity, classificationLabel(request)))
        } `;
        const fill = w - 2 - visibleWidth(title) - visibleWidth(meta) - 1;
        if (fill >= 1) {
          lines.push(fit(`${theme.fg("accent", "──")}${title}${theme.fg("accent", "─".repeat(fill))} ${meta}`));
        } else {
          // Too narrow for one header line: keep the classification fully visible on its own line.
          const rest = Math.max(0, w - 2 - visibleWidth(title));
          lines.push(fit(`${theme.fg("accent", "──")}${title}${theme.fg("accent", "─".repeat(rest))}`));
          for (const part of wrapTextWithAnsi(meta.trimEnd(), Math.max(10, w - 1))) lines.push(fit(` ${part}`));
        }

        // Label/value rows with a hanging indent so wrapped text aligns with the value column.
        const labelWidth = 7;
        const field = (label: string, value: string, color: "text" | "warning" | "error" = "text") => {
          const valueWidth = Math.max(10, w - labelWidth - 1);
          const wrapped = value.split("\n").flatMap((part) => wrapTextWithAnsi(part, valueWidth));
          wrapped.forEach((part, index) => {
            const prefix = index === 0 ? theme.fg("muted", label.padEnd(labelWidth)) : " ".repeat(labelWidth);
            lines.push(fit(` ${prefix}${theme.fg(color, part)}`));
          });
        };

        if (request.classifier?.model) field("Model", request.classifier.model);
        field("Action", clip(displayAction(request), MAX_ACTION_LENGTH));
        field(failure ? "Failure" : "Reason", clip(request.reason, MAX_REASON_LENGTH), severity);

        // Collapsible classifier details.
        toggleRow = -1;
        if (attempts.length) {
          toggleRow = lines.length;
          const arrow = expanded ? "▾" : "▸";
          const label = `${arrow} Classifier details (${attempts.length} attempt${attempts.length === 1 ? "" : "s"})`;
          lines.push(fit(` ${theme.fg("dim", label)}${theme.fg("dim", expanded ? "  [r] hide" : "  [r] show")}`));
          if (expanded) {
            for (const attempt of attempts) {
              const details = attemptDetails(attempt);
              lines.push(fit(`   ${theme.fg("accent", details[0] ?? "attempt")}`));
              for (const detail of details.slice(1)) {
                for (const part of wrapTextWithAnsi(detail, Math.max(10, w - 5))) {
                  lines.push(fit(`     ${theme.fg("dim", part)}`));
                }
              }
            }
          }
        }

        lines.push("");

        // Buttons: one row when they fit, otherwise one per line.
        const renderButton = (label: string, active: boolean) =>
          active
            ? theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${label} `)))
            : theme.fg("text", ` ${label} `);
        const gap = "  ";
        const rowWidth = 1 + options.reduce((sum, option) => sum + option.length + 2, 0) + gap.length * (options.length - 1);
        buttonsVertical = rowWidth > w;
        buttonSpans = [];
        buttonRow = lines.length;
        if (buttonsVertical) {
          options.forEach((option, index) => {
            lines.push(fit(` ${renderButton(option, index === selected)}`));
          });
        } else {
          let column = 1;
          const parts = options.map((option, index) => {
            buttonSpans.push({ start: column, end: column + option.length + 2 });
            column += option.length + 2 + gap.length;
            return renderButton(option, index === selected);
          });
          lines.push(fit(` ${parts.join(gap)}`));
        }

        const arrows = buttonsVertical ? "↑↓" : "←→";
        const detailsHint = attempts.length ? " · r details" : "";
        lines.push(fit(theme.fg("dim", ` ${arrows} choose · enter confirm${detailsHint} · esc deny`)));
        lines.push(theme.fg("accent", "─".repeat(w)));
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        const prev = buttonsVertical ? Key.up : Key.left;
        const next = buttonsVertical ? Key.down : Key.right;
        if (matchesKey(data, prev) || matchesKey(data, Key.up) || matchesKey(data, Key.shift(Key.tab))) {
          selected = Math.max(0, selected - 1);
          tui.requestRender();
        } else if (matchesKey(data, next) || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
          selected = Math.min(options.length - 1, selected + 1);
          tui.requestRender();
        } else if (matchesKey(data, Key.enter)) {
          done(options[selected]);
        } else if (attempts.length && (matchesKey(data, "r") || matchesKey(data, Key.space))) {
          toggleDetails();
        } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(undefined);
        }
      },
      // Mouse: clicking the details row toggles it; clicking a button only selects it
      // (Enter still confirms), so a stray click can never approve an action.
      handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (event.type !== "click" || event.button !== "left") return undefined;
        if (event.y === toggleRow) {
          toggleDetails();
          return { handled: true };
        }
        if (buttonsVertical) {
          const index = event.y - buttonRow;
          if (index >= 0 && index < options.length) {
            selected = index;
            return { handled: true };
          }
        } else if (event.y === buttonRow) {
          const index = buttonSpans.findIndex((span) => event.x >= span.start && event.x < span.end);
          if (index >= 0) {
            selected = index;
            return { handled: true };
          }
        }
        return undefined;
      },
    };
    return component;
  });
}

