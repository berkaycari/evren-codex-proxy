import type { FastifyInstance, FastifyReply } from "fastify";
import { BridgeService, UsageMissingError } from "../bridge/bridge-service.js";
import { encodeResponseSse } from "../bridge/sse.js";
import { ToolProtocolError } from "../bridge/tool-protocol.js";
import { InvalidRequestError } from "../bridge/normalize-codex-request.js";
import { InvalidNativeToolChoiceError } from "../bridge/native-codex-to-evren.js";
import { LimitExceededError } from "../safety/limits.js";
import { PricingBlockedError } from "../safety/pricing-guard.js";
import { InvalidToolCallSessionError, UnknownPreviousResponseError } from "../sessions/store.js";
import { AccountingUncertainError } from "../usage/tracker.js";
import type { EventSink } from "../ui/logger.js";

export function registerResponsesRoute(
  app: FastifyInstance,
  bridge: BridgeService,
  logger: EventSink,
): void {
  app.post("/v1/responses", async (request, reply) => {
    try {
      const result = await bridge.handle(request.body);
      if (result.stream) {
        return reply
          .header("content-type", "text/event-stream; charset=utf-8")
          .header("cache-control", "no-cache")
          .header("connection", "keep-alive")
          .send(encodeResponseSse(result));
      }
      return reply.send(result.response);
    } catch (error) {
      logger.log({
        event: error instanceof LimitExceededError ? "SESSION_LIMIT_REACHED" : "ERROR",
        level: "error",
        message: error instanceof Error ? error.message : "Unknown bridge error.",
      });
      return sendError(reply, error);
    }
  });
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  let status = 500;
  let type = "server_error";
  let code = "bridge_error";
  let message = "The bridge could not complete the request.";
  if (error instanceof InvalidRequestError
    || error instanceof InvalidNativeToolChoiceError
    || error instanceof UnknownPreviousResponseError
    || error instanceof InvalidToolCallSessionError) {
    status = 400;
    type = "invalid_request_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof LimitExceededError) {
    status = 429;
    type = "rate_limit_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof PricingBlockedError) {
    status = 503;
    type = "pricing_blocked_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof AccountingUncertainError || error instanceof UsageMissingError) {
    status = 502;
    type = "upstream_usage_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof ToolProtocolError) {
    status = 502;
    type = "upstream_protocol_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  }
  return reply.status(status).send({
    error: { message, type, param: null, code },
  });
}
