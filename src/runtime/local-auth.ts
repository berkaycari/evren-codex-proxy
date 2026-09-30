import { randomBytes } from "node:crypto";

export const LOCAL_BRIDGE_TOKEN_BYTES = 32;

export function generateLocalBridgeToken(): string {
  return randomBytes(LOCAL_BRIDGE_TOKEN_BYTES).toString("base64url");
}
