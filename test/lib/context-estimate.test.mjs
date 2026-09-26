import test from "node:test";
import assert from "node:assert/strict";
import { estimateContextTokens } from "../../src/lib/context-estimate.mjs";

test("prices plain text at roughly one token per four characters", () => {
  // "role" contributes its own 4 chars ("user") to the char count, same as before this change.
  const body = { messages: [{ role: "user", content: "a".repeat(400) }] };
  assert.equal(estimateContextTokens(body), 101);
});

test("a pasted screenshot no longer reads as a million-token conversation (#41)", () => {
  // The issue's own repro: a 4MB base64 image, which encoded_length/4 would price at ~1M.
  const body = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "A".repeat(4_000_000) },
          },
        ],
      },
    ],
  };
  const tokens = estimateContextTokens(body);
  assert.ok(tokens < 10_000, `expected a flat per-image ceiling, got ${tokens}`);
});

test("Codex's input_image is priced the same as Claude's image", () => {
  const body = {
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }],
  };
  assert.ok(estimateContextTokens(body) < 10_000);
});

test("a document block is priced by a per-page ceiling, not its encoded length", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "document", source: { type: "base64", data: "A".repeat(2_000_000) } }] },
    ],
  };
  const tokens = estimateContextTokens(body);
  assert.ok(tokens > 0 && tokens < 10_000, `expected a flat per-document ceiling, got ${tokens}`);
});

test("text alongside an image still counts, on top of the image's flat cost", () => {
  const body = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(400) },
          { type: "image", source: { type: "base64", data: "A".repeat(1_000_000) } },
        ],
      },
    ],
  };
  const textOnly = estimateContextTokens({ messages: [{ role: "user", content: "a".repeat(400) }] });
  assert.ok(estimateContextTokens(body) > textOnly);
});

test("an empty or malformed body estimates to zero rather than throwing", () => {
  assert.equal(estimateContextTokens({}), 0);
  assert.equal(estimateContextTokens({ messages: null }), 0);
  assert.equal(estimateContextTokens(undefined), 0);
});
