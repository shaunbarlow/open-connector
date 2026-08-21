import { describe, expect, it } from "vitest";
import { buildBetterStackTelemetryHost, buildBetterStackTelemetryTableName } from "./runtime.ts";

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

describe("buildBetterStackTelemetryTableName", () => {
  it("prefixes the table name with t<team_id>_, matching the verified working run_query example", () => {
    expect(buildBetterStackTelemetryTableName({ teamId: 251435, tableName: "payments_prod" }, "_logs")).toBe(
      "t251435_payments_prod_logs",
    );
  });

  it("supports metrics granularity suffixes", () => {
    const source = { teamId: 251435, tableName: "payments_prod" };
    expect(buildBetterStackTelemetryTableName(source, "_metrics")).toBe("t251435_payments_prod_metrics");
    expect(buildBetterStackTelemetryTableName(source, "_metrics_5m")).toBe("t251435_payments_prod_metrics_5m");
    expect(buildBetterStackTelemetryTableName(source, "_metrics_1h")).toBe("t251435_payments_prod_metrics_1h");
  });

  it("supports the s3 cold-storage suffix", () => {
    expect(buildBetterStackTelemetryTableName({ teamId: 251435, tableName: "payments_prod" }, "_s3")).toBe(
      "t251435_payments_prod_s3",
    );
  });
});
