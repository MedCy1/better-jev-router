/**
 * Estimates the token size of a request body for the cache-rebuild guard and Jev's
 * `contextSize` signal — never billed, so a rough estimate is fine, but it must not be
 * dominated by base64 payloads (#41).
 *
 * `JSON.stringify(body).length / 4` prices a pasted image or PDF by its *encoded* byte
 * length, which reads nothing like what the API actually bills it at: a 4MB base64
 * screenshot alone comes out to roughly a million fictitious tokens, saturating
 * `contextSize` and holding every later downgrade behind the cache-rebuild guard for the
 * rest of the session. Anthropic's own limits: a high-resolution image tops out at 4784
 * tokens regardless of encoded size; a PDF page is priced by extracted text (roughly
 * 1500-3000 tokens) plus a per-page image cost. This still is not exact — CJK text is
 * under-counted by `String.length`'s UTF-16-unit counting, and unmeasured `url`/`file_id`
 * sources fall back to a flat per-item guess — but it no longer confuses one screenshot
 * with a million-token conversation.
 */

// Conservative flat costs, deliberately on the high side so a downgrade is never allowed
// through on an underestimate. Named sources are counted by their content when it is
// present (a base64 payload); an unmeasured reference (a `url` or `file_id`) still needs
// *some* estimate, so it takes the same ceiling as a fully-inlined one of that kind.
const IMAGE_TOKENS = 1600; // Anthropic's high-detail ceiling is 4784; most pasted images are smaller.
const DOCUMENT_TOKENS = 3000; // One PDF page's text-plus-image ceiling; most documents are one page.

const BASE64_TYPES = new Set(["image", "input_image", "document", "input_file"]);

function textLength(node, mediaTokens) {
  if (typeof node === "string") return node.length;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + textLength(item, mediaTokens), 0);
  if (!node || typeof node !== "object") return 0;

  if (BASE64_TYPES.has(node.type)) {
    const isDocument = node.type === "document" || node.type === "input_file";
    mediaTokens.total += isDocument ? DOCUMENT_TOKENS : IMAGE_TOKENS;
    return 0; // Counted as tokens directly, not folded into the char/4 estimate below.
  }

  let sum = 0;
  for (const value of Object.values(node)) sum += textLength(value, mediaTokens);
  return sum;
}

/**
 * Rough token estimate for `messages` (Claude) or `input` (Codex), pricing base64 image and
 * document blocks by a flat ceiling instead of their encoded length.
 */
export function estimateContextTokens(body) {
  const mediaTokens = { total: 0 };
  const chars = textLength(body?.messages ?? body?.input ?? "", mediaTokens);
  return Math.round(chars / 4) + mediaTokens.total;
}
