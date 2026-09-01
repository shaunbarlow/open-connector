import { describe, expect, it } from "vitest";
import { buildRtmAuthUrl, signRtmParams } from "./runtime.ts";

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
      buildRtmAuthUrl({ apiKey: "abc123", sharedSecret: "BANANAS" }, { perms: "delete", frob: "123456" }),
    );

    expect(url.origin + url.pathname).toBe("https://www.rememberthemilk.com/services/auth/");
    expect(url.searchParams.get("api_key")).toBe("abc123");
    expect(url.searchParams.get("perms")).toBe("delete");
    expect(url.searchParams.get("frob")).toBe("123456");
    expect(url.searchParams.get("api_sig")).toBe(
      signRtmParams("BANANAS", { api_key: "abc123", perms: "delete", frob: "123456" }),
    );
  });
});
