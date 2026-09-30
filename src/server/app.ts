import Fastify, { type FastifyInstance } from "fastify";
import type { BridgeService } from "../bridge/bridge-service.js";
import type { BridgeConfig } from "../config.js";
import type { PricingGuard } from "../safety/pricing-guard.js";
import type { SessionStore } from "../sessions/store.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { EventSink } from "../ui/logger.js";
import type { EvrenCreditState } from "../evren/client.js";
import { registerHealthRoute } from "./health.js";
import { registerModelsRoute } from "./models.js";
import { registerResponsesRoute } from "./responses.js";
import type { UpdateCheckState } from "../update/checker.js";
import { timingSafeEqual } from "node:crypto";

export function buildServer(deps: {
  config: BridgeConfig;
  pricingGuard: Pick<PricingGuard, "getState">;
  sessions: SessionStore;
  usage: UsageTracker;
  bridge: BridgeService;
  logger: EventSink;
  credits?: { getCreditState(): EvrenCreditState };
  updateCheck?: { getState(): UpdateCheckState };
  localClientAuthToken?: string;
}): FastifyInstance {
  // A validated 20 MB local image expands by roughly 4/3 when Codex serializes it as a data URL.
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024 });
  if (deps.localClientAuthToken !== undefined) {
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/v1/")) return;
      const authorization = request.headers.authorization;
      const expected = `Bearer ${deps.localClientAuthToken}`;
      if (!constantTimeEqual(authorization, expected)) {
        await reply.status(401).send({
          error: {
            message: "Local Bridge authentication failed.",
            type: "authentication_error",
            param: null,
            code: "invalid_local_bridge_token",
          },
        });
      }
    });
  }
  registerHealthRoute(app, deps);
  registerModelsRoute(app);
  registerResponsesRoute(app, deps.bridge, deps.logger);
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({
    error: {
      message: "Endpoint not found.",
      type: "invalid_request_error",
      param: null,
      code: "not_found",
    },
  }));
  return app;
}

function constantTimeEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
