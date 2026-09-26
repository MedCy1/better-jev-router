/**
 * The Anthropic model table: how this account's Claude models map onto the neutral tier
 * names in `../config.mjs`.
 *
 * Only the Claude adapter (`src/proxy.mjs`) reads this. Codex keeps the equivalent mapping in
 * `src/codex-proxy.mjs`, keyed by the same tier names, so the policy layer never has to know
 * which vendor it is routing for.
 */
import { TIER_NAMES } from "../config.mjs";

/**
 * Tiers in the same order as `TIER_NAMES`, cheapest first. `id` is what goes into the API
 * request body; `family` is the substring used to recognize whatever model Claude Code asked
 * for, which may be an older version within the same tier such as `claude-sonnet-4-6`. The
 * capability flags come from the Agent SDK's model catalog: Haiku supports neither adaptive
 * thinking nor effort, so those fields have to be stripped when routing down to it.
 * `contextWindow` is each model's real input window (#41) — Haiku 4.5 is still 200K, but
 * Sonnet 5, Opus 5, and Fable 5.1 all take 1M, so a single constant misreports every one of
 * them and cannot tell a 250K conversation from an 800K one to Jev.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false, contextWindow: 200_000 },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true, contextWindow: 1_000_000 },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true, contextWindow: 1_000_000 },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true, contextWindow: 1_000_000 },
];

/**
 * The tier table and the neutral name list are edited by hand in two files, so a mismatch
 * would silently misroute. Fail loudly at import instead.
 */
const names = TIERS.map((t) => t.name);
if (names.length !== TIER_NAMES.length || names.some((n, i) => n !== TIER_NAMES[i])) {
  throw new Error(`Claude tier table ${names.join()} does not match TIER_NAMES ${TIER_NAMES.join()}`);
}

/** Smallest context window across all tiers — the safe fallback before a tier is known. */
export const CONTEXT_WINDOW_TOKENS = Math.min(...TIERS.map((t) => t.contextWindow));

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/** Real input window for a tier, or the smallest window when the tier is unrecognized. */
export const contextWindowOf = (name) => tierSpec(name)?.contextWindow ?? CONTEXT_WINDOW_TOKENS;

/** Tier name for a model string Claude Code sent, or null if we don't recognize it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;
