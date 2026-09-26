import { availableTiers, shouldUseExactModel } from "./config.mjs";
import { decide } from "./policy.mjs";
import { askJev } from "./router.mjs";
import { writeDecision } from "./status.mjs";

/**
 * One candidate per tier: the configured model for that tier when it's present in `models`,
 * otherwise the first candidate of that tier in catalog order (#49).
 */
function dedupeByTier(models, getDefaultModel) {
  return Object.values(
    models.reduce((byTier, model) => {
      if (!byTier[model.tier] || model.id === getDefaultModel?.(model.tier)) byTier[model.tier] = model;
      return byTier;
    }, {}),
  );
}

/**
 * Route one new user turn without assuming any harness or wire protocol.
 *
 * `getDefaultModel` is needed only when policy lands on a different tier without accepting
 * Jev's exact model (for example, an explicit override or an availability clamp). A native
 * caller can omit it when `models` contains one canonical model per tier.
 *
 * @param {object} input
 * @param {string} input.prompt
 * @param {string} input.current Current routing tier.
 * @param {string} input.currentModel Exact model currently in use.
 * @param {Array<{id: string, tier: string, description?: string}>} input.models
 * @param {number} input.contextTokens
 * @param {number} input.contextWindow
 * @param {string} [input.statusId]
 * @param {(tier: string) => string} [input.getDefaultModel]
 * @param {typeof askJev} [input.route]
 * @returns {Promise<{tier: string, model: string, reason: string, confidence: number | null, metrics: object | null, jev: object | null, at: number}>}
 */
export async function routeTurn({
  prompt,
  current,
  currentModel,
  models = [],
  contextTokens = 0,
  contextWindow,
  statusId = "",
  getDefaultModel = (tier) => models.find((model) => model.tier === tier)?.id,
  // Whether several models mapped to the same tier are meaningfully different choices for
  // Jev (Claude: claude-opus-5 vs claude-opus-4-8, a real version tradeoff) or duplicates
  // that should collapse to one candidate before Jev sees them (Codex's account catalog can
  // list several same-capability models per tier, which would otherwise split the vote
  // across them — see dedupeSameTierModels below). Off by default to match every existing
  // caller's behavior; only the Codex adapter turns it on.
  dedupeSameTierModels = false,
  route = askJev,
}) {
  // Disabled tiers are not offered to Jev, matching the proxy's historical behavior.
  const enabledModels = models.filter((model) => availableTiers().includes(model.tier));
  const routedModels = dedupeSameTierModels
    ? dedupeByTier(enabledModels, getDefaultModel)
    : enabledModels;
  const available = [...new Set(enabledModels.map((model) => model.tier))];

  const jevAnswer = await route({
    prompt,
    current: currentModel,
    contextTokens,
    models: routedModels,
    contextWindow,
  });

  const chosen = routedModels.find((model) => model.id === jevAnswer?.choice);
  const tierAnswer = jevAnswer && { ...jevAnswer, choice: chosen?.tier };
  const policy = decide({ prompt, jev: tierAnswer, current, available, contextTokens });
  const tier = policy.tier;
  const model = shouldUseExactModel(policy.reason, chosen?.tier, tier)
    ? chosen.id
    : tier === current
      ? currentModel
      : getDefaultModel?.(tier);

  const decision = {
    tier,
    model,
    // The tier Jev actually chose, before policy may override it (low confidence, cache
    // guard, unavailable tier, ...). `jev-explain` shows this next to the selected tier so a
    // disagreement between the two is visible instead of always echoing the final choice.
    jevTier: chosen?.tier ?? null,
    reason: policy.reason,
    confidence: jevAnswer?.confidence ?? null,
    metrics: jevAnswer?.metrics ?? null,
    jev: jevAnswer ? { request: jevAnswer.request, response: jevAnswer.response } : null,
    at: Date.now(),
  };

  if (statusId) {
    writeDecision(statusId, {
      tier,
      prompt,
      model,
      jevTier: decision.jevTier,
      confidence: decision.confidence,
      metrics: decision.metrics,
      reason: decision.reason,
      jev: decision.jev,
      at: decision.at,
    });
  }
  return decision;
}
