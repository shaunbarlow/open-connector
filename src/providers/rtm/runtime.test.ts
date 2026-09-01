import type { RtmActionContext } from "./runtime.ts";

import { describe, expect, it, vi } from "vitest";
import { buildRtmAuthUrl, rtmActionHandlers, signRtmParams } from "./runtime.ts";

const testApiKey = ["abc", "123"].join("");
const testSharedSecret = "BANANAS";

function jsonFetcher(payload: unknown): typeof fetch {
  return async () => Response.json(payload);
}

function createTestContext(overrides: Partial<RtmActionContext> = {}): RtmActionContext {
  return {
    apiKey: testApiKey,
    sharedSecret: testSharedSecret,
    fetcher: jsonFetcher({ rsp: { stat: "ok", frob: "123456" } }),
    ...overrides,
  };
}

describe("signRtmParams", () => {
  it("matches the documented Remember The Milk signing example", () => {
    // From https://www.rememberthemilk.com/services/api/authentication.rtm:
    // shared secret "BANANAS", params yxz=foo, feg=bar, abc=baz sort to
    // abc=baz&feg=bar&yxz=foo, concatenated as "abcbazfegbaryxzfoo", and MD5
    // of "BANANASabcbazfegbaryxzfoo" is the documented signature below.
    const signature = signRtmParams("BANANAS", { yxz: "foo", feg: "bar", abc: "baz" });
    expect(signature).toBe("82044aae4dd676094f23f1ec152159ba");
  });

  it("is order-independent since parameters are sorted before signing", () => {
    const a = signRtmParams("secret", { b: "2", a: "1", c: "3" });
    const b = signRtmParams("secret", { c: "3", a: "1", b: "2" });
    expect(a).toBe(b);
  });
});

describe("buildRtmAuthUrl", () => {
  it("builds a signed authorization URL with the expected parameters", () => {
    const url = new URL(
      buildRtmAuthUrl({ apiKey: testApiKey, sharedSecret: testSharedSecret }, { perms: "delete", frob: "123456" }),
    );

    expect(url.origin + url.pathname).toBe("https://www.rememberthemilk.com/services/auth/");
    expect(url.searchParams.get("api_key")).toBe(testApiKey);
    expect(url.searchParams.get("perms")).toBe("delete");
    expect(url.searchParams.get("frob")).toBe("123456");
    expect(url.searchParams.get("api_sig")).toBe(
      signRtmParams(testSharedSecret, { api_key: testApiKey, perms: "delete", frob: "123456" }),
    );
  });
});

describe("start_auth", () => {
  it("returns the raw signed authUrl when the runtime has no short-link support", async () => {
    const context = createTestContext();

    const result = (await rtmActionHandlers.start_auth({}, context)) as { authUrl: string; frob: string };

    expect(result.frob).toBe("123456");
    const url = new URL(result.authUrl);
    expect(url.origin + url.pathname).toBe("https://www.rememberthemilk.com/services/auth/");
    expect(url.searchParams.get("api_key")).toBe(testApiKey);
    expect(url.searchParams.has("api_sig")).toBe(true);
  });

  it("exchanges the signed authUrl for an opaque short link when the runtime supports it", async () => {
    const shortLink = "https://connect.example.com/r/opaque-token";
    const createShortLink = vi.fn(async (_url: string) => shortLink);
    const context = createTestContext({ createShortLink });

    const result = (await rtmActionHandlers.start_auth({}, context)) as { authUrl: string; frob: string };

    expect(createShortLink).toHaveBeenCalledTimes(1);
    const [signedUrl] = createShortLink.mock.calls[0]!;
    expect(new URL(signedUrl).searchParams.get("api_key")).toBe(testApiKey);
    expect(new URL(signedUrl).searchParams.has("api_sig")).toBe(true);
    expect(result.authUrl).toBe(shortLink);
    expect(result.authUrl).not.toContain(testApiKey);
  });

  it("passes the requested perms through to the signed URL registered as a short link", async () => {
    const createShortLink = vi.fn(async (_url: string) => "https://connect.example.com/r/opaque-token");
    const context = createTestContext({ createShortLink });

    await rtmActionHandlers.start_auth({ perms: "read" }, context);

    const [signedUrl] = createShortLink.mock.calls[0]!;
    expect(new URL(signedUrl).searchParams.get("perms")).toBe("read");
  });
});
