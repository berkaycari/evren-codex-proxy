import { loadConfig } from "../src/config.js";
import { EvrenClient } from "../src/evren/client.js";
import { evaluateModelPricing } from "../src/evren/pricing.js";
import { nullLogger } from "../src/ui/logger.js";

const apiKey = process.env.EVREN_API_KEY?.trim();
if (!apiKey) {
  console.error("EVREN_API_KEY is required. Set it in the current process; the script never prints it.");
  process.exitCode = 1;
} else {
  const config = loadConfig();
  const client = new EvrenClient({
    baseUrl: config.evrenBaseUrl,
    apiKey,
    model: config.model,
    timeoutMs: config.requestTimeoutMs,
    logger: nullLogger,
  });
  const pricing = evaluateModelPricing(await client.getModels(), config.model);
  if (!pricing.allowed) throw new Error(`Pricing guard blocked smoke inference: ${pricing.reason}`);
  console.log("Pricing: exact 0 CR verified.");
  const result = await client.infer(
    'Return only this JSON object: {"kind":"final","content":"EVREN_SMOKE_OK"}',
    64,
  );
  if (!result.usage) throw new Error("EVREN smoke response omitted valid usage.");
  console.log(`Response: ${result.text.slice(0, 500)}`);
  console.log(`Usage: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}, total=${result.usage.totalTokens}`);
}
