# pi-automode-te-ext

Additions to this fork of [`@czottmann/pi-automode`](https://github.com/czottmann/pi-automode). It merges two former standalone extensions, `pi-automode-review` and `pi-automode-classifier-retry`. Both features now use one small hook in pi-automode.

- **Classifier retry.** When the classifier fails for operational reasons (timeout, provider error, missing model, or malformed output), the original tool call waits and is classified again. Delays: 2 s, 5 s, 10 s ×10, then 30 s until Esc. The main agent model is not involved, and the call keeps its exact arguments.
- **Review dialog.** When the classifier really denies a call, a themed dialog shows the action, the reason, and the raw classifier attempts. Choices are **Allow once**, **Deny**, and **Disable auto mode and deny**. Allow once is never offered for `hard_deny` or for operational failures.

This extension never runs tools and never calls a model. Every retry is a full classifier check, so nothing runs without a real `allow` or an explicit user **Allow once**.

## Layout

All fork-specific code lives in separate files, so upstream updates rarely conflict:

| File | Purpose |
| --- | --- |
| `extensions/auto-mode/te-ext-hook.ts` | The hook: event contract and the two safety rules. |
| `extensions/auto-mode/extension.ts` | The hook call site, the only upstream file with logic changes. See [The hook](#the-hook). |
| `package.json` | Registers this extension in `pi.extensions`. |
| `extensions/pi-automode-te-ext/index.ts` | Policy: what to retry, when to review, status UI, `/automode-review-test`. |
| `extensions/pi-automode-te-ext/retry.ts` | Retry schedule, structured failure detection, wait/abort. |
| `extensions/pi-automode-te-ext/review.ts` | Review dialog (TUI component plus a select fallback). |
| `extensions/pi-automode-te-ext/pi-automode-te-ext-hook.patch` | Reference diff of all upstream-file changes. |
| `tests/te-ext.test.ts` | Hook, retry policy, and end-to-end tests. |

## Behavior

pi-automode emits `pi-automode:classifier-block` after every non-allow classifier result. This extension answers:

1. **Retryable operational failure** with an abort signal: wait for the next delay, then `retry`. The status bar shows `classifier unavailable: retry #3 (bash) in 7s, Esc to stop`. Parallel calls each keep their own countdown.
2. **Other operational failure**, or the wait was aborted: `deny` with a message telling the main model that the classifier was unavailable, not that the action is unsafe. No dialog.
3. **Real classifier verdict** with a UI: open the review dialog. Without a UI, the stock deny applies.

### What counts as retryable

The decision uses the structured `ClassifyResult.io`, never the reason text.

| Outcome | Detected by | Retry |
| --- | --- | --- |
| Real verdict (`soft_deny`, `hard_deny`, or a model-returned `tier: "none"` block) | any `io.attempts[].parsed` | never |
| Model or API key unavailable | no `io` | yes |
| Request threw (network, timeout, auth) | last attempt `error` | yes |
| Provider error, aborted, or truncated response | last `response.stopReason` is `error`, `aborted`, or `length` | yes |
| Detailed stage returned no valid decision tool call | last attempt is `detailed` without `parsed` | yes |
| Fast stage output other than `0`/`1` | last attempt is `fast`, text not `0`/`1` | yes |
| Fast request exceeds the classifier context window | `io` with no attempts | no |
| Fast said `1`, detailed request exceeds the context window | last attempt is `fast` with text `1` | no |

Real verdicts are never retried. Re-asking until the classifier says allow would quietly weaken auto mode. Reason text cannot enforce this, because a model-written reason could imitate a failure message. Context-window failures are deterministic for the same input. Calls without an abort signal are not retried, because the wait must stay interruptible.

## The hook

`te-ext-hook.ts` carries facts out of pi-automode and enforces two rules, so a buggy listener cannot weaken auto mode:

- **No listener, or listener does not set `handled`:** plain deny, identical to stock pi-automode.
- **`allow-once` for anything other than a real non-`hard_deny` verdict:** downgraded to `deny`.

The listener also receives a `structuredClone` of the result, so mutating it cannot change pi-automode's decision.

Call site changes in `extension.ts`:

- The single `classify(...)` call becomes a loop. After each non-allow result, the hook is asked:
  - `retry`: classify the same serialized action again; each attempt goes through `logClassifierIo`.
  - `allow-once`: count it as a classifier allow and allow the call, with reason `Allowed once by user after auto-mode review: …`.
  - `disable-and-deny`: set `state.enabledOverride = false`, then block.
  - `deny`: block.
- `block(...)` takes an optional `modelReason`, which replaces the model-facing text. It is used for the operational-failure message. Logging, counters, denial records, and the user notification are unchanged.

### Event contract

```ts
// pi.events: "pi-automode:classifier-block"
{
  toolName: string;
  toolCallId: string;
  action: string;          // pi-automode action summary
  result: ClassifyResult;  // snapshot, including io (prompt, attempts) when available
  resolved: boolean;       // false: no classifier model/API key resolved
  verdict: boolean;        // true: some attempt produced a parsed decision
  attempt: number;         // 1-based count of classifications for this call
  signal: AbortSignal | undefined;
  handled: boolean;        // listener must set true synchronously
  respond(answer:
    | { action: "retry" }
    | { action: "allow-once" }
    | { action: "deny"; message?: string }
    | { action: "disable-and-deny"; message?: string }): void;
}
```

A listener that sets `handled` must eventually call `respond`. Otherwise the tool call waits. This extension responds `deny` when the turn's abort signal fires during a retry wait.

### Logging

- `decision` line: one per tool call, final outcome only.
- `message` (usage) lines: one per classifier response, including failed retries that got a response.
- `classifier` lines (`classifierIo: true` only): one per classification, sharing the call's `decisionId`.

## Install

This fork is a Pi package. Both extensions load from its `package.json`.

```bash
pi install git:github.com/Weeeqt/pi-automode
```

Configuration stays in `~/.pi/agent/extensions/pi-automode/config.json`, the same as the npm package.

## Updating from upstream

```bash
git remote add upstream https://github.com/czottmann/pi-automode   # once
git fetch upstream
git merge upstream/main     # or rebase
npm ci && npm run check && npm test
```

Expected conflicts are limited to the hook call site in `extensions/auto-mode/extension.ts`, the `block(...)` signature, and `pi.extensions` in `package.json`. `pi-automode-te-ext-hook.patch` shows the exact intended change. Re-apply it by hand if a merge gets messy.

After an upstream update, check:

- The `tool_call` handler still has a single `classify(...)` call followed by `logClassifierIo` and an allow/block split.
- `ClassifyResult.io.attempts[]` still records every model request with `stage`, `error`, `parsed` (only for valid decisions), and `response.stopReason` and `text`.
- `defaultClassifyAction` still omits `io` when no model or API key resolves.
- Context-window checks still run before a request is sent.

If any of these change, update `retry.ts` and the [retry table](#what-counts-as-retryable), then run `tests/te-ext.test.ts`.

## Safe UI test

```text
/automode-review-test          # synthetic soft_deny: all three choices
/automode-review-test hard     # synthetic hard_deny: no Allow once
/automode-review-test failure  # operational failure: no dialog
```

These create no tool call and change nothing, including auto mode state.

## Tests

`tests/te-ext.test.ts` runs the real staged classifier against scripted provider responses and the real patched `tool_call` handler. It covers every row of the retry table, the hook's safety rules, the no-listener fallback, Esc during a wait, and the review choices.
