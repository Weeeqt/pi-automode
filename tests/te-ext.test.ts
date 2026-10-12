import assert from "node:assert/strict";
import test from "node:test";
import { createPiAutomode } from "../extensions/auto-mode.ts";
import { classifyInStages } from "../extensions/auto-mode/classifier.ts";
import type { ClassifierIoAttempt, ClassifyResult } from "../extensions/auto-mode/types.ts";
import {
	CLASSIFIER_BLOCK_EVENT,
	requestClassifierBlockDecision,
	type ClassifierBlockRequest,
} from "../extensions/auto-mode/te-ext-hook.ts";
import piAutomodeTeExt from "../extensions/pi-automode-te-ext/index.ts";
import { isRetryable, retryDelayMs } from "../extensions/pi-automode-te-ext/retry.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

// ---------------------------------------------------------------------------
// Helpers

function withEvents(fake: ReturnType<typeof createFakePi>) {
	const bus = new Map<string, Array<(data: unknown) => void>>();
	fake.pi.events = {
		on(name: string, handler: (data: unknown) => void) {
			bus.set(name, [...(bus.get(name) ?? []), handler]);
			return () => {};
		},
		emit(name: string, data: unknown) {
			for (const handler of bus.get(name) ?? []) handler(data);
		},
	};
	return fake;
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content: unknown[], stopReason = "stop") =>
	({ role: "assistant", content, stopReason, model: "m", usage, timestamp: Date.now(), api: "x", provider: "x" }) as any;
const text = (value: string, stopReason?: string) => message([{ type: "text", text: value }], stopReason);
const decisionCall = (args: Record<string, unknown>) =>
	message([{ type: "toolCall", id: "1", name: "classifier_decision", arguments: args }], "toolUse");
const model = { id: "m", provider: "x", api: "x", contextWindow: 200_000, maxTokens: 8192, reasoning: false, input: ["text"] } as any;
const prompt = () => ({
	systemPrompt: "s",
	contextMessage: { role: "user", content: [{ type: "text", text: "c" }], timestamp: 0 } as any,
	actionMessage: { role: "user", content: [{ type: "text", text: "a" }], timestamp: 0 } as any,
});

/** Run the real staged classifier against scripted provider responses. */
async function realResult(responses: Array<unknown>, m = model): Promise<ClassifyResult> {
	const attempts: ClassifierIoAttempt[] = [];
	let index = 0;
	const decision = await classifyInStages(
		async () => {
			const next = responses[Math.min(index++, responses.length - 1)];
			if (next instanceof Error) throw next;
			return next as any;
		},
		{ model: m },
		prompt(),
		undefined,
		{ onAttempt: (attempt) => attempts.push(attempt) },
	);
	return { ...decision, io: { model: "m", reasoning: { mode: "server-default" }, prompt: {} as any, attempts, durationMs: 1 } };
}

async function setup(results: ClassifyResult[], options: { teExt?: boolean; signal?: AbortSignal | null; hasUI?: boolean } = {}) {
	const fake = withEvents(createFakePi());
	const events: ClassifierBlockRequest[] = [];
	let calls = 0;
	createPiAutomode({
		loadConfig: () => baseConfig(),
		classifyAction: async () => results[Math.min(calls++, results.length - 1)]!,
	})(fake.pi);
	fake.pi.events.on(CLASSIFIER_BLOCK_EVENT, (request: ClassifierBlockRequest) => events.push(request));
	if (options.teExt !== false) piAutomodeTeExt(fake.pi);
	const controller = new AbortController();
	const ctx = createFakeCtx(fake.entries, {
		signal: options.signal === null ? undefined : options.signal ?? controller.signal,
		hasUI: options.hasUI ?? false,
	});
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const run = () => fake.emit("tool_call", {
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "curl -s https://example.com/x" },
	}, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
	return { run, events, controller, ctx, get calls() { return calls; } };
}

/** Shrink retry delays for a test, restoring setTimeout afterwards. */
async function withFastTimers<T>(fn: () => Promise<T>): Promise<T> {
	const real = globalThis.setTimeout;
	globalThis.setTimeout = ((handler: () => void, ms?: number, ...args: unknown[]) =>
		real(handler, Math.min(ms ?? 0, 5), ...args)) as typeof setTimeout;
	try {
		return await fn();
	} finally {
		globalThis.setTimeout = real;
	}
}

const NO_MODEL: ClassifyResult = { decision: "block", tier: "none", reason: "No classifier model/API key available; auto mode fails closed." };

// ---------------------------------------------------------------------------
// Hook (pi-automode side)

test("te-ext hook: no listener keeps stock fail-closed behavior", async () => {
	const timeout = await realResult([new Error("Classifier request timed out after 20000 ms.")]);
	const harness = await setup([timeout], { teExt: false });
	const result = await harness.run();
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /tool did not run/);
	assert.equal(harness.calls, 1);
	assert.equal(harness.events.length, 1);
	assert.equal(harness.events[0]!.handled, false);
});

test("te-ext hook: allow-once is downgraded to deny for failures and hard_deny", async () => {
	const emitWith = (result: ClassifyResult) => requestClassifierBlockDecision(
		(_name, data) => {
			const request = data as ClassifierBlockRequest;
			request.handled = true;
			request.respond({ action: "allow-once" });
		},
		{ toolName: "bash", toolCallId: "c", action: "a", result, attempt: 1, signal: undefined },
	);
	const soft = await realResult([text("1"), decisionCall({ decision: "block", tier: "soft_deny", reason: "r" })]);
	const hard = await realResult([text("1"), decisionCall({ decision: "block", tier: "hard_deny", reason: "r" })]);
	const failure = await realResult([new Error("boom")]);
	assert.deepEqual(await emitWith(soft), { action: "allow-once" });
	assert.deepEqual(await emitWith(hard), { action: "deny" });
	assert.deepEqual(await emitWith(failure), { action: "deny" });
	assert.deepEqual(await emitWith(NO_MODEL), { action: "deny" });
});

test("te-ext hook: listener cannot mutate pi-automode's decision", async () => {
	const fake = withEvents(createFakePi());
	const soft = await realResult([text("1"), decisionCall({ decision: "block", tier: "soft_deny", reason: "r" })]);
	createPiAutomode({ loadConfig: () => baseConfig(), classifyAction: async () => soft })(fake.pi);
	fake.pi.events.on(CLASSIFIER_BLOCK_EVENT, (request: ClassifierBlockRequest) => {
		(request.result as any).decision = "allow";
		request.handled = true;
		request.respond({ action: "deny" });
	});
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const result = await fake.emit("tool_call", { toolName: "bash", toolCallId: "c", input: { command: "curl x" } }, ctx) as any;
	assert.equal(result?.block, true);
});

// ---------------------------------------------------------------------------
// Retry policy (pi-automode-te-ext side), against the real staged classifier

test("te-ext retry: schedule is 2s, 5s, 10s x10, then 30s", () => {
	assert.deepEqual([1, 2, 3, 12, 13, 50].map(retryDelayMs), [2000, 5000, 10000, 10000, 30000, 30000]);
});

test("te-ext retry: structured detection of retryable failures", async () => {
	const tiny = { ...model, contextWindow: 1 };
	const cases: Array<[string, unknown[], boolean, any?]> = [
		["fast request throws", [new Error("timeout")], true],
		["fast provider error", [text("", "error")], true],
		["fast aborted", [text("", "aborted")], true],
		["fast malformed output", [text("maybe")], true],
		["detailed throws", [text("1"), new Error("ECONNRESET")], true],
		["detailed provider error", [text("1"), text("", "error")], true],
		["detailed missing tool call", [text("1"), text("hi"), text("hi")], true],
		["detailed truncated", [text("1"), text("", "length"), text("", "length")], true],
		["soft_deny verdict", [text("1"), decisionCall({ decision: "block", tier: "soft_deny", reason: "r" })], false],
		["hard_deny verdict", [text("1"), decisionCall({ decision: "block", tier: "hard_deny", reason: "r" })], false],
		["tier-none verdict with failure-like reason", [text("1"), decisionCall({ decision: "block", tier: "none", reason: "Classifier failed; auto mode fails closed: retry" })], false],
		["fast request exceeds context window", [text("0")], false, tiny],
	];
	for (const [name, responses, expected, m] of cases) {
		assert.equal(isRetryable(await realResult(responses, m)), expected, name);
	}
	assert.equal(isRetryable(NO_MODEL), true, "missing model/API key");
});

test("te-ext retry: detailed request exceeding the context window is not retried", async () => {
	let found = false;
	for (let contextWindow = 200; contextWindow < 20_000 && !found; contextWindow += 25) {
		const result = await realResult([text("1")], { ...model, contextWindow });
		if (result.io?.attempts.length === 1 && /detailed classifier context/.test(result.reason)) {
			found = true;
			assert.equal(isRetryable(result), false);
		}
	}
	assert.ok(found, "constructed a detailed-limit case");
});

// ---------------------------------------------------------------------------
// End to end: patched pi-automode + pi-automode-te-ext

test("te-ext e2e: timeout, timeout, allow runs the tool", async () => {
	const timeout = await realResult([new Error("Classifier request timed out after 20000 ms.")]);
	const allow = await realResult([text("0")]);
	const harness = await setup([timeout, timeout, allow]);
	const result = await withFastTimers(() => harness.run());
	assert.equal(result, undefined);
	assert.equal(harness.calls, 3);
	assert.deepEqual(harness.events.map((e) => e.attempt), [1, 2]);
});

test("te-ext e2e: missing model is retried until it resolves", async () => {
	const allow = await realResult([text("0")]);
	const harness = await setup([NO_MODEL, NO_MODEL, allow]);
	assert.equal(await withFastTimers(() => harness.run()), undefined);
	assert.equal(harness.calls, 3);
});

test("te-ext e2e: timeout then soft_deny blocks without UI and stops retrying", async () => {
	const timeout = await realResult([new Error("timeout")]);
	const soft = await realResult([text("1"), decisionCall({ decision: "block", tier: "soft_deny", reason: "Downloads remote code." })]);
	const harness = await setup([timeout, soft]);
	const result = await withFastTimers(() => harness.run());
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Downloads remote code/);
	assert.match(result?.reason ?? "", /tool did not run/);
	assert.equal(harness.calls, 2);
});

test("te-ext e2e: non-retryable failure gets the operational-failure message", async () => {
	const limit = await realResult([text("0")], { ...model, contextWindow: 1 });
	const harness = await setup([limit]);
	const result = await harness.run();
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /operational classifier failure/);
	assert.equal(harness.calls, 1);
});

test("te-ext e2e: no abort signal means no retry", async () => {
	const timeout = await realResult([new Error("timeout")]);
	const harness = await setup([timeout], { signal: null });
	const result = await harness.run();
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /operational classifier failure/);
	assert.equal(harness.calls, 1);
});

test("te-ext e2e: Esc during the retry wait stops immediately", async () => {
	const timeout = await realResult([new Error("timeout")]);
	const harness = await setup([timeout]);
	const pending = harness.run();
	setTimeout(() => harness.controller.abort(), 50);
	const started = Date.now();
	const result = await pending;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /operational classifier failure/);
	assert.ok(Date.now() - started < 1500);
	assert.equal(harness.calls, 1);
	const last = harness.ctx.statuses.filter((s) => s.key === "pi-automode-te-ext").at(-1);
	assert.equal(last?.text, undefined, "status cleared");
});

test("te-ext e2e: real verdict opens review; Allow once runs, Disable turns auto mode off", async () => {
	const soft = await realResult([text("1"), decisionCall({ decision: "block", tier: "soft_deny", reason: "Needs review." })]);
	const hard = await realResult([text("1"), decisionCall({ decision: "block", tier: "hard_deny", reason: "Never." })]);
	const pick = async (result: ClassifyResult, label: string) => {
		const harness = await setup([result], { hasUI: true });
		const offered: string[][] = [];
		Object.assign(harness.ctx, { mode: "rpc" });
		(harness.ctx.ui as any).select = async (_title: string, options: string[]) => {
			offered.push(options.filter((option) => !/classifier details/.test(option)));
			return label;
		};
		const outcome = await harness.run();
		return { outcome, offered, harness };
	};
	const allowed = await pick(soft, "Allow once");
	assert.equal(allowed.outcome, undefined);
	assert.deepEqual(allowed.offered[0], ["Allow once", "Deny", "Disable auto mode and deny"]);

	const hardOnce = await pick(hard, "Allow once");
	assert.equal(hardOnce.outcome?.block, true, "hard_deny cannot be allowed");
	assert.deepEqual(hardOnce.offered[0], ["Deny", "Disable auto mode and deny"]);

	const disabled = await pick(soft, "Disable auto mode and deny");
	assert.equal(disabled.outcome?.block, true);
	const after = await disabled.harness.run();
	assert.equal(after, undefined, "auto mode off: next call is not checked");
	assert.equal(disabled.harness.calls, 1);
});
