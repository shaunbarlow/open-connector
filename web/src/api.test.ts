import { afterEach, describe, expect, it, vi } from "vitest";
import { apiDelete, ApiError, apiGet } from "./api";

describe("readJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the parsed payload for successful responses", async () => {
    stubFetch(Response.json({ authenticated: true }));

    await expect(apiGet("/api/auth/session")).resolves.toEqual({ authenticated: true });
  });

  it("rejects successful responses whose body is not JSON", async () => {
    // A gzip payload reaching the client undecoded is the real-world case: the
    // status is 200, so nothing else in the app treats the response as failed.
    stubFetch(new Response(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), { status: 200 }));

    const error = await apiGet("/api/auth/session").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(200);
    expect((error as ApiError).message).toMatch(/not JSON/);
  });

  it("keeps returning null for successful responses with an empty body", async () => {
    stubFetch(new Response(null, { status: 204 }));

    await expect(apiDelete("/api/runtime-tokens/token-1")).resolves.toBeNull();
  });

  it("reports the server error message when the failed body is JSON", async () => {
    stubFetch(Response.json({ errorMessage: "Connection not found." }, { status: 404 }));

    await expect(apiGet("/api/connections/example")).rejects.toThrow("Connection not found.");
  });

  it("falls back to the status when the failed body is not JSON", async () => {
    stubFetch(new Response("<html>502</html>", { status: 502 }));

    await expect(apiGet("/api/providers")).rejects.toThrow("Request failed with 502");
  });
});

describe("reverse-proxy base path resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves absolute-looking API paths against an explicit <base> element when present", async () => {
    // Regression test: Claworc's control plane reverse-proxies this app at
    // /connector/* and injects <base href="/connector/"> into the served
    // HTML. A plain fetch("/api/...") ignores <base> (leading "/" is always
    // origin-relative), so every API call bypassed the proxy prefix and hit
    // Claworc's own /api/* routes instead of the connector's. This asserts
    // the fetch target is rewritten to honor an explicit base element.
    const fetchMock = vi.fn(async () => Response.json({ authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", {
      querySelector: (selector: string) =>
        selector === "base" ? { href: "https://claworc.example/connector/" } : null,
    });

    await apiGet("/api/auth/session");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://claworc.example/connector/api/auth/session",
      expect.anything(),
    );
  });

  it("leaves the path untouched when no <base> element exists (standalone deployment)", async () => {
    // Without an explicit <base> tag, document.baseURI equals the current
    // SPA route's URL, and naive relative resolution against it would break
    // nested routes like /actions/:actionId ("api/foo" resolving to
    // "/actions/api/foo" instead of "/api/foo"). Gating on an explicit
    // <base> element avoids that regression in the standalone deployment.
    const fetchMock = vi.fn(async () => Response.json({ authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { querySelector: () => null });

    await apiGet("/api/auth/session");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.anything());
  });

  it("falls back to the raw path when document is unavailable (e.g. Node test/SSR environments)", async () => {
    const fetchMock = vi.fn(async () => Response.json({ authenticated: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiGet("/api/auth/session");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/session", expect.anything());
  });
});

function stubFetch(response: Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response),
  );
}
