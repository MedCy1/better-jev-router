import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { formatExplanation, readStatus, routeTurn, STATUS_DIR } from "../../src/lib/index.mjs";

const models = [
  { id: "test-haiku-v1", tier: "haiku" },
  { id: "test-sonnet-v1", tier: "sonnet" },
  { id: "test-opus-v2", tier: "opus" },
];
const defaults = {
  haiku: "test-haiku-v1",
  sonnet: "test-sonnet-v1",
  opus: "test-opus-default",
};

test("routeTurn consults the router, applies policy, resolves the exact model, and records the decision", async (t) => {
  const statusId = `route-turn-${process.pid}-${Date.now()}`;
  t.after(() => {
    try {
      unlinkSync(join(STATUS_DIR, `${statusId}.json`));
    } catch {
      // A failed status write leaves nothing to clean up; the assertions below report it.
    }
  });

  let routeInput;
  const decision = await routeTurn({
    prompt: "Refactor the parser safely",
    current: "sonnet",
    currentModel: "test-sonnet-v1",
    models,
    contextTokens: 1_200,
    contextWindow: 100_000,
    statusId,
    getDefaultModel: (tier) => defaults[tier],
    route: async (input) => {
      routeInput = input;
      return {
        choice: "test-opus-v2",
        confidence: 0.91,
        metrics: { taskComplexity: 0.8 },
        request: { state: { session: { current_model: input.current, context_tokens: input.contextTokens } } },
        response: { answers: { model_tier: { choice: "opus" } } },
        ms: 4,
      };
    },
  });

  assert.equal(routeInput.current, "test-sonnet-v1");
  assert.equal(routeInput.contextWindow, 100_000);
  assert.deepEqual(routeInput.models, models);
  assert.equal(decision.tier, "opus");
  assert.equal(decision.model, "test-opus-v2");
  assert.equal(decision.jevTier, "opus");
  assert.equal(decision.reason, "jev");
  assert.equal(decision.confidence, 0.91);
  assert.equal(typeof decision.at, "number");

  const recorded = readStatus(statusId);
  assert.equal(recorded.prompt, "Refactor the parser safely");
  assert.equal(recorded.model, "test-opus-v2");
  assert.equal(recorded.jevTier, "opus");
  assert.equal(recorded.history.length, 1);
  assert.match(formatExplanation(recorded), /Selected model: TEST-OPUS-V2/);
});

test("routeTurn keeps the current exact model when policy rejects a low-confidence downgrade", async () => {
  const decision = await routeTurn({
    prompt: "Investigate the race",
    current: "opus",
    currentModel: "test-opus-current",
    models,
    contextTokens: 500,
    contextWindow: 100_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async () => ({ choice: "test-haiku-v1", confidence: 0.1 }),
  });

  assert.equal(decision.tier, "opus");
  assert.equal(decision.model, "test-opus-current");
  assert.match(decision.reason, /low-confidence-no-downgrade/);
  // Jev still recommended haiku; policy just refused to act on it. jev-explain needs both.
  assert.equal(decision.jevTier, "haiku");
});

test("routeTurn degrades safely to the current model when the router returns null", async () => {
  let calls = 0;
  const decision = await routeTurn({
    prompt: "Continue the current task",
    current: "sonnet",
    currentModel: "test-sonnet-current",
    models,
    contextTokens: 800,
    contextWindow: 100_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async () => {
      calls++;
      return null;
    },
  });

  assert.equal(calls, 1);
  assert.equal(decision.tier, "sonnet");
  assert.equal(decision.model, "test-sonnet-current");
  assert.equal(decision.confidence, null);
  assert.match(decision.reason, /jev-unavailable/);
});

test("routeTurn never offers the router a tier the operator has disabled", async () => {
  // `fable` bills extra usage credits, so it is unavailable unless JEV_ALLOW_FABLE is set.
  // Offering it to the router would spend a choice the policy ladder could only clamp away.
  const seen = [];
  await routeTurn({
    prompt: "write the migration",
    current: "sonnet",
    currentModel: "test-sonnet-v1",
    models: [...models, { id: "test-fable-v1", tier: "fable" }],
    contextTokens: 100,
    getDefaultModel: (tier) => defaults[tier],
    route: async ({ models: offered }) => {
      seen.push(...offered.map((model) => model.tier));
      return null;
    },
  });

  assert.equal(seen.includes("fable"), false, "a disabled tier must never reach the router");
  assert.deepEqual(seen, ["haiku", "sonnet", "opus"]);
});

test("dedupeSameTierModels collapses same-tier duplicates so Jev's vote isn't split (#49)", async () => {
  // The issue's own catalog: two "luna" models both reading as haiku, and two "sol" models
  // both reading as opus, alongside the configured defaults.
  const duplicated = [
    { id: "gpt-5.6-luna", tier: "haiku" },
    { id: "gpt-6-luna", tier: "haiku" },
    { id: "gpt-5.6-terra", tier: "sonnet" },
    { id: "gpt-5.6-sol", tier: "opus" },
    { id: "gpt-6-sol", tier: "opus" },
  ];
  const codexDefaults = { haiku: "gpt-5.6-luna", sonnet: "gpt-5.6-terra", opus: "gpt-5.6-sol" };
  const seen = [];
  await routeTurn({
    prompt: "Reply with just the word: pong.",
    current: "opus",
    currentModel: "gpt-6-sol",
    models: duplicated,
    contextTokens: 50,
    dedupeSameTierModels: true,
    getDefaultModel: (tier) => codexDefaults[tier],
    route: async ({ models: offered }) => {
      seen.push(...offered.map((model) => model.id));
      return { choice: "gpt-5.6-luna", confidence: 0.98 };
    },
  });

  assert.deepEqual(seen, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"], "one candidate per tier");
});

test("dedupeSameTierModels prefers the configured model, else the first candidate in catalog order", async () => {
  const seen = [];
  await routeTurn({
    prompt: "task",
    current: "opus",
    currentModel: "gpt-6-sol",
    // Configured default for opus ("gpt-5.6-sol") is not first in catalog order, but must
    // still win over "gpt-6-sol".
    models: [{ id: "gpt-6-sol", tier: "opus" }, { id: "gpt-5.6-sol", tier: "opus" }],
    contextTokens: 50,
    dedupeSameTierModels: true,
    getDefaultModel: (tier) => ({ opus: "gpt-5.6-sol" })[tier],
    route: async ({ models: offered }) => {
      seen.push(...offered.map((model) => model.id));
      return null;
    },
  });

  assert.deepEqual(seen, ["gpt-5.6-sol"]);
});

test("without dedupeSameTierModels, same-tier models still reach the router as separate choices", async () => {
  // Claude's model versions within one tier (claude-opus-5 vs claude-opus-4-8) are a real
  // choice for Jev, not duplicates — the default behavior must keep offering both.
  const seen = [];
  await routeTurn({
    prompt: "task",
    current: "opus",
    currentModel: "claude-opus-5",
    models: [{ id: "claude-opus-5", tier: "opus" }, { id: "claude-opus-4-8", tier: "opus" }],
    contextTokens: 50,
    getDefaultModel: (tier) => defaults[tier],
    route: async ({ models: offered }) => {
      seen.push(...offered.map((model) => model.id));
      return null;
    },
  });

  assert.deepEqual(seen, ["claude-opus-5", "claude-opus-4-8"]);
});
