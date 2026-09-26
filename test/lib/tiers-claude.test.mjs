import test from "node:test";
import assert from "node:assert/strict";
import { contextWindowOf, CONTEXT_WINDOW_TOKENS } from "../../src/lib/tiers/claude.mjs";

test("each tier reports its real context window, not one shared constant (#41)", () => {
  assert.equal(contextWindowOf("haiku"), 200_000);
  assert.equal(contextWindowOf("sonnet"), 1_000_000);
  assert.equal(contextWindowOf("opus"), 1_000_000);
  assert.equal(contextWindowOf("fable"), 1_000_000);
});

test("an unrecognized tier falls back to the smallest window", () => {
  assert.equal(contextWindowOf("nonsense"), CONTEXT_WINDOW_TOKENS);
  assert.equal(CONTEXT_WINDOW_TOKENS, 200_000);
});
