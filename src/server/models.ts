import type { FastifyInstance } from "fastify";

export function registerModelsRoute(app: FastifyInstance): void {
  app.get("/v1/models", async () => {
    // Codex 0.156.1 expects its own catalog wrapper, not OpenAI's {object,data} shape.
    // Empty is intentionally honest: the configured model remains usable without invented metadata.
    return { models: [] };
  });
}
