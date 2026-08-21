import { describe, expect, it } from "vitest";
import { buildBetterStackTelemetryHost } from "./runtime.ts";

describe("buildBetterStackTelemetryHost", () => {
  it("builds the regional SQL API host from a data_region", () => {
    expect(buildBetterStackTelemetryHost("eu-nbg-2")).toBe("eu-nbg-2-connect.betterstackdata.com");
    expect(buildBetterStackTelemetryHost("us-east-1")).toBe("us-east-1-connect.betterstackdata.com");
  });

  it("trims surrounding whitespace", () => {
    expect(buildBetterStackTelemetryHost("  eu-nbg-2  ")).toBe("eu-nbg-2-connect.betterstackdata.com");
  });

  it("rejects an empty region", () => {
    expect(() => buildBetterStackTelemetryHost("")).toThrow("data_region");
  });

  it("rejects a region containing unexpected characters", () => {
    expect(() => buildBetterStackTelemetryHost("eu-nbg-2/../evil.com")).toThrow("data_region");
    expect(() => buildBetterStackTelemetryHost("eu nbg 2")).toThrow("data_region");
  });
});
