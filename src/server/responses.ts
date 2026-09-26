import type { FastifyInstance, FastifyReply } from "fastify";
import { BridgeService, UsageMissingError } from "../bridge/bridge-service.js";
import { encodeResponseSse } from "../bridge/sse.js";
import { ToolProtocolError } from "../bridge/tool-protocol.js";
import { InvalidRequestError } from "../bridge/normalize-codex-request.js";
import { InvalidNativeToolChoiceError } from "../bridge/native-codex-to-evren.js";
import { LimitExceededError } from "../safety/limits.js";
import { PricingBlockedError } from "../safety/pricing-guard.js";
import { ConflictingSessionIdentityError, InvalidToolCallSessionError, UnknownPreviousResponseError } from "../sessions/store.js";
import { AccountingUncertainError } from "../usage/tracker.js";
import { RetryCircuitBlockedError } from "../safety/deterministic-retry-circuit.js";
import { ToolPollLimitError } from "../bridge/tool-polling.js";
import type { EventSink } from "../ui/logger.js";
import { CreditBudgetUnsupportedError, CreditFloorExceededError } from "../safety/credit-policy.js";

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
    || error instanceof ConflictingSessionIdentityError
    || error instanceof InvalidToolCallSessionError
    || error instanceof ToolPollLimitError) {
    status = 400;
    type = "invalid_request_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof LimitExceededError) {
    status = 429;
    type = "rate_limit_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof CreditFloorExceededError) {
    status = 429;
    type = "credit_limit_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof CreditBudgetUnsupportedError) {
    status = 503;
    type = "credit_policy_error";
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
  } else if (error instanceof ToolProtocolError || error instanceof RetryCircuitBlockedError) {
    status = 502;
    type = "upstream_protocol_error";
    code = error.code;
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
  }
  const details = error instanceof LimitExceededError
    ? {
      limit_name: error.limitName,
      current: error.current,
      limit: error.limit,
      recoverable: error.recoverable,
      ...(error.recommended === undefined ? {} : { recommended: error.recommended }),
    }
    : error instanceof CreditFloorExceededError
      ? { remaining: error.remaining, minimum: error.minimum, recoverable: false }
      : {};
  const helpfulMessage = error instanceof LimitExceededError && error.recoverable
    ? `${message} Local EVREN Bridge limit reached; ${error.inferenceMade ? "authoritative usage was recorded before the post-response limit check" : "no additional EVREN inference was made"}. No failed request is replayed automatically. In the Bridge terminal press R to raise only the recommended limit, or use F1 -> C. Then return to Codex and continue the task.`
    : message;
  return reply.status(status).send({
    error: { message: helpfulMessage, type, param: null, code, ...details },
  });
}
