import { describe, expect, it, vi } from "vitest";
import type { LogEvent } from "../src/ui/logger.js";
import { UpdateChecker } from "../src/update/checker.js";

function response(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checker(fetchImpl: typeof fetch, currentVersion = "1.1.0", timeoutMs = 50) {
  const events: LogEvent[] = [];
  return {
    events,
    value: new UpdateChecker({
      enabled: true,
      currentVersion,
      timeoutMs,
      fetch: fetchImpl,
      logger: { log: (event) => events.push(event) },
    }),
  };
}

describe("anonymous GitHub release checker", () => {
  it.each([
    ["newer release", "1.1.0", "v1.2.0", "update_available", "1.2.0"],
    ["equal release", "1.2.0", "v1.2.0", "up_to_date", undefined],
    ["local newer", "1.3.0", "v1.2.0", "local_newer", undefined],
  ])("handles %s", async (_label, current, tag, status, available) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(200, { tag_name: tag, draft: false, prerelease: false }));
    const { value } = checker(fetchMock, current);
    await expect(value.checkOnce()).resolves.toMatchObject({
      status,
      ...(available === undefined ? {} : { updateAvailableVersion: available }),
    });
  });

  it.each([
    ["malformed JSON", response(200, "not-json"), "malformed_response"],
    ["invalid tag", response(200, { tag_name: "v1.2.0-beta.1" }), "invalid_tag"],
    ["draft", response(200, { tag_name: "v1.2.0", draft: true }), "invalid_tag"],
    ["rate limit", response(403, { message: "rate limit" }), "rate_limited"],
    ["GitHub error", response(500, {}), "http_error"],
  ])("fails safely for %s", async (_label, mockedResponse, status) => {
    const { value } = checker(vi.fn<typeof fetch>().mockResolvedValue(mockedResponse));
    await expect(value.checkOnce()).resolves.toMatchObject({ status });
  });

  it("handles offline failure without throwing", async () => {
    const { value } = checker(vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    await expect(value.checkOnce()).resolves.toMatchObject({ status: "offline" });
  });

  it("uses a short timeout and calls the public endpoint at most once", async () => {
    const fetchMock = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }));
    const { value } = checker(fetchMock, "1.1.0", 5);
    const [first, second] = await Promise.all([value.checkOnce(), value.checkOnce()]);
    expect(first.status).toBe("timeout");
    expect(second.status).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends no EVREN key or application data", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(200, { tag_name: "v1.2.0" }));
    const { value } = checker(fetchMock);
    await value.checkOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/berkaycari/evren-codex-proxy/releases/latest");
    expect(init?.method).toBe("GET");
    expect(init).not.toHaveProperty("body");
    expect(JSON.stringify(init?.headers)).not.toMatch(/api[_-]?key|authorization|prompt|session|tool/i);
  });

  it("can be disabled without any request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const value = new UpdateChecker({
      enabled: false,
      currentVersion: "1.1.0",
      fetch: fetchMock,
      logger: { log: () => undefined },
    });
    await expect(value.checkOnce()).resolves.toEqual({ status: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can be reconfigured without allowing a stale in-flight result to overwrite disabled state", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const { value } = checker(fetchMock);
    const pending = value.checkOnce();

    expect(value.setEnabled(false)).toBe(false);
    expect(value.getState()).toEqual({ status: "disabled" });
    resolveFetch(response(200, { tag_name: "v9.9.9" }));
    await pending;

    expect(value.getState()).toEqual({ status: "disabled" });
    expect(value.setEnabled(true)).toBe(true);
    expect(value.getState()).toEqual({ status: "not_checked" });
  });
});
