import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import { askJev } from "./lib/router.mjs";
import { routeTurn } from "./lib/route-turn.mjs";
import { log } from "./lib/log.mjs";
import { writeStatus } from "./lib/status.mjs";
import { validateAdapter } from "./adapters/index.mjs";
import { estimateContextTokens } from "./lib/context-estimate.mjs";

const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Generic proxy that accepts a harness adapter.
 *
 * Each harness (Claude, Codex, Agent Orchestrator, etc.) has a different wire protocol
 * for requests and responses. This proxy parametrizes the routing logic — the eight-step
 * pipeline that appears in both proxy.mjs and codex-proxy.mjs — and delegates the protocol
 * details to an adapter.
 *
 * The adapter must provide:
 *
 *   - isRoutingRequest(req, body) → boolean: Is this a turn we should route?
 *   - conversationKey(body) → string: Stable identifier for deduping the conversation.
 *   - newTurnPrompt(body) → string | null: The user's prompt, or null for tool continuations.
 *   - normalizeRequest(body) → void (optional): Normalize every parsed request body.
 *   - getModels(catalog) → {id, tier, description}[]: Available models for this harness.
 *   - applyTier(body, tier, model) → body: Mutate the request for this tier.
 *   - getDefaultModel(tier) → string: Fallback model id for a tier.
 *   - decorateModelCatalog(catalog, catalogMap) → void (optional): Ingest/decorate a model catalog.
 *   - decorateResponse(res, response, routing) → void: Inject harness-specific feedback.
 *   - decorateRequestHeaders(headers, body, upstreamURL) → void (optional): Add outbound
 *     headers once the final request body is known — after applyTier has rewritten
 *     body.model (for example Codex's routing hint, only sent to its ChatGPT backend).
 *   - contextWindow: input tokens for the current tier, as a fixed number or a
 *     (tier) => number resolver, for harnesses whose tiers don't share a context window.
 *   - dedupeSameTierModels (optional): true when several models mapped to the same tier are
 *     interchangeable duplicates, not a meaningful choice — collapses them to one candidate
 *     before Jev sees them, so its vote isn't split across near-identical options (#49, Codex).
 *     Leave unset when different models in a tier are a real tradeoff (Claude's model
 *     versions within one tier).
 *   - statusId (optional): A fixed id or (body, conversationKey) → id for status writes.
 *
 * upstreamURL may be a fixed string or a (req) → string resolver.
 *
 * Adapters Claude Code and Codex both export their adapter structure from their own files.
 */
export async function genericProxy({
  adapter,
  upstreamURL,
  route = askJev,
  catalog = new Map(),
} = {}) {
  validateAdapter(adapter);

  // Tier routed for each conversation's turn in flight, reused by its follow-ups.
  const conversations = new Map();
  const stateFor = (key) => {
    let s = conversations.get(key);
    if (!s) {
      if (conversations.size > 50) conversations.delete(conversations.keys().next().value);
      conversations.set(key, (s = { tier: null, model: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Probes (HEAD requests for Claude, others) should pass through.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing = null; // For response decoration
      let requestBody = null; // For decorateRequestHeaders, set once JSON parsing succeeds

      try {
        const body = JSON.parse(out.toString());
        requestBody = body;

        if (process.env.JEV_DUMP) {
          writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
        }

        adapter.normalizeRequest?.(body);

        if (adapter.isRoutingRequest?.(req, body)) {
          const key = adapter.conversationKey?.(body);
          const state = stateFor(key);
          const current = state.tier ?? "opus";
          const models = adapter.getModels?.(catalog) ?? [];
          if (!models.length) {
            // The adapter has nothing it can route to right now (for example, Codex's virtual
            // model was already encoded for a request protocol none of the enabled models
            // share). Routing must never silently forward to something that will 400.
            debug(`${key} routing unavailable: adapter reports no candidate models`);
            res.writeHead(502, { "content-type": "application/json" });
            return res.end(JSON.stringify({
              error: { message: "Jev Router: no enabled models match the request protocol.", type: "proxy_error" },
            }));
          }
          const prompt = adapter.newTurnPrompt?.(body);
          const explaining = prompt?.includes("<jev-explain>") || prompt?.includes("$jev-explain");

          if (prompt && !explaining) {
            const currentModel = state.model ?? adapter.getDefaultModel?.(current);
            const contextTokens = estimateContextTokens(body);
            const statusKey =
              typeof adapter.statusId === "function"
                ? adapter.statusId(body, key)
                : adapter.statusId || "";
            let jev;
            const decision = await routeTurn({
              prompt,
              current,
              currentModel,
              models,
              // The cache-rebuild guard protects a prompt cache built on `current`. The first
              // turn of a conversation has none yet, however large its opening message is
              // (Claude Code injects CLAUDE.md and hook output into it).
              contextTokens: state.tier ? contextTokens : 0,
              contextWindow:
                typeof adapter.contextWindow === "function"
                  ? adapter.contextWindow(current)
                  : adapter.contextWindow,
              statusId: statusKey,
              dedupeSameTierModels: adapter.dedupeSameTierModels ?? false,
              getDefaultModel: (tier) => adapter.getDefaultModel?.(tier),
              route: async (input) => (jev = await route(input)),
            });
            state.tier = decision.tier;
            state.model = decision.model;
            routing = {
              prompt,
              model: decision.model,
              confidence: decision.confidence,
              metrics: decision.metrics,
              reason: decision.reason,
              jev: decision.jev,
              at: decision.at,
            };
            debug(
              `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                `${current} -> ${decision.tier} (${decision.reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
            );

          } else if (prompt) {
            // Explaining request — skip routing but mark as manual if it's a real turn.
            const statusKey =
              typeof adapter.statusId === "function"
                ? adapter.statusId(body, key)
                : adapter.statusId || "";
            writeStatus(statusKey, { manual: true, at: Date.now() });
          }

          // The sentinel is not a real model, so every routed request must be rewritten.
          const tier = state.tier ?? current;
          // A tool-continuation reuses the tier chosen at the start of the turn without a
          // fresh decision, but the exact model cached for it can stop being a valid
          // candidate between requests (Codex's enabled-model catalog can change mid-turn).
          // Re-deriving it from the current candidates, rather than forwarding a stale one
          // straight to the wire, is what keeps that case from ever reaching an upstream 400.
          const cachedModelStillValid = models.some((candidate) => candidate.id === state.model);
          const model =
            (cachedModelStillValid && state.model) ||
            models.find((candidate) => candidate.tier === tier)?.id ||
            models[0]?.id ||
            adapter.getDefaultModel?.(tier);
          adapter.applyTier?.(body, tier, model);
        } else {
          // Not a routing request — check if it's an explicit model choice (manual).
          if (adapter.isManualChoice?.(req, body)) {
            const key = adapter.conversationKey?.(body);
            const statusKey =
              typeof adapter.statusId === "function"
                ? adapter.statusId(body, key)
                : adapter.statusId || "";
            writeStatus(statusKey, { manual: true, at: Date.now() });
          }
        }

        out = Buffer.from(JSON.stringify(body));
      } catch (err) {
        debug(`generic-proxy: could not process body: ${err.message}`);
      }

      // Proxy the request upstream.
      const resolvedUpstreamURL =
        typeof upstreamURL === "function" ? upstreamURL(req) : upstreamURL;
      const target = new URL(resolvedUpstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
      if (isModels) delete headers["accept-encoding"];
      if (requestBody) adapter.decorateRequestHeaders?.(headers, requestBody, resolvedUpstreamURL);

      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (response) => {
          // Special handling for model catalog endpoints.
          if (isModels && adapter.decorateModelCatalog) {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              try {
                const data = Buffer.concat(chunks);
                const modelCatalog = JSON.parse(data.toString());
                adapter.decorateModelCatalog?.(modelCatalog, catalog);
                const newData = Buffer.from(JSON.stringify(modelCatalog));
                const newHeaders = { ...response.headers };
                delete newHeaders["content-length"];
                res.writeHead(response.statusCode, newHeaders);
                res.end(newData);
              } catch (err) {
                debug(`could not decorate model catalog: ${err.message}`);
                res.writeHead(response.statusCode, response.headers);
                res.end(Buffer.concat(chunks));
              }
            });
            return;
          }

          // Allow the adapter to decorate the response (e.g., SSE injection for Codex).
          if (routing && response.statusCode >= 200 && response.statusCode < 300 && adapter.decorateResponse) {
            adapter.decorateResponse?.(res, response, routing);
          } else {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          }
        },
      );

      upstream.on("error", (err) => {
        debug(`upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });

      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
