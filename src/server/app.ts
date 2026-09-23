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

export function buildServer(deps: {
  config: BridgeConfig;
  pricingGuard: Pick<PricingGuard, "getState">;
  sessions: SessionStore;
  usage: UsageTracker;
  bridge: BridgeService;
  logger: EventSink;
  credits?: { getCreditState(): EvrenCreditState };
}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
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
