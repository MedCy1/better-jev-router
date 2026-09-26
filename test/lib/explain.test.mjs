import test from "node:test";
import assert from "node:assert/strict";
import { formatExplanation } from "../../src/lib/explain.mjs";

test("formats the last routing decision", () => {
  const output = formatExplanation({
    prompt: "Explain the router architecture",
    tier: "sonnet",
    jevTier: "sonnet",
    confidence: 0.94,
    reason: "jev",
    jev: {
      request: { state: { session: { current_model: "haiku", context_tokens: 6200 } } },
      response: { answers: { model: { choice: "claude-sonnet-5" } } },
    },
    metrics: {
      taskComplexity: 0.82,
      reasoningRequired: 0.91,
      toolComplexity: 0.64,
      contextSize: 0.31,
    },
  });

  assert.match(output, /Task complexity     0\.82/);
  assert.match(output, /Prompt: Explain the router/);
  assert.match(output, /Current tier: HAIKU/);
  assert.match(output, /Context tokens: 6200/);
  assert.match(output, /Recommended tier: SONNET/);
  assert.match(output, /Selected model: SONNET/);
  assert.match(output, /Confidence: 94%/);
  assert.match(output, /Decision: Jev recommendation/);
});

test("shows Jev's actual recommendation, not just the tier policy settled on", () => {
  // Jev recommended a haiku downgrade, but policy held opus (low confidence, say). The two
  // rows must be able to disagree — that disagreement is the point of showing both (#40).
  const output = formatExplanation({
    tier: "opus",
    jevTier: "haiku",
    confidence: 0.25,
    reason: "low-confidence-no-downgrade",
  });

  assert.match(output, /Recommended tier: HAIKU/);
  assert.match(output, /Selected model: OPUS/);
});

test("falls back to the selected tier when Jev's answer was never recorded", () => {
  assert.match(formatExplanation({ tier: "opus", reason: "jev-unavailable" }), /Recommended tier: OPUS/);
});

test("shows the concrete provider model when available", () => {
  assert.match(
    formatExplanation({ tier: "haiku", model: "gpt-5.6-luna", confidence: 0.99 }),
    /Selected model: GPT-5\.6-LUNA/,
  );
});
