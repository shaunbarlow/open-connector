import { describe, expect, it } from "vitest";
import { ShortLinkError, ShortLinkService } from "./short-link-service.ts";

class MemoryShortLinkStore {
  private readonly records = new Map<string, { url: string; expiresAt: string }>();

  async add(record: { token: string; url: string; createdAt: string; expiresAt: string }): Promise<void> {
    this.records.set(record.token, { url: record.url, expiresAt: record.expiresAt });
  }

  async resolve(token: string): Promise<string | undefined> {
    const record = this.records.get(token);
    if (!record) {
      return undefined;
    }
    if (Date.parse(record.expiresAt) <= Date.now()) {
      this.records.delete(token);
      return undefined;
    }
    return record.url;
  }
}

function createService(publicOrigin: string): ShortLinkService {
  return new ShortLinkService({ store: new MemoryShortLinkStore(), publicOrigin });
}

describe("ShortLinkService", () => {
  it("issues a link under the public origin that resolves back to the target URL", async () => {
    const service = createService("https://connect.example.com");

    const targetUrl = "https://api.example.com/auth?api_key=***&api_sig=abc123";
    const link = await service.create(targetUrl);
    expect(link).toMatch(/^https:\/\/connect\.example\.com\/r\/[A-Za-z0-9_-]{20,}$/);
    expect(link).not.toContain("api_key");
    expect(link).not.toContain("api_sig");

    const token = link.split("/r/")[1];
    await expect(service.resolve(token)).resolves.toBe(targetUrl);
  });

  it("strips a trailing slash from the configured public origin", async () => {
    const service = createService("https://connect.example.com/");

    const link = await service.create("https://api.example.com/auth?token=***");
    expect(link.startsWith("https://connect.example.com/r/")).toBe(true);
    expect(link).not.toContain("//r/");
  });

  it("generates distinct unguessable tokens for repeated calls", async () => {
    const service = createService("https://connect.example.com");

    const first = await service.create("https://api.example.com/a?token=***");
    const second = await service.create("https://api.example.com/b?token=***");
    expect(first).not.toBe(second);
  });

  it("resolves undefined for an unknown token", async () => {
    const service = createService("https://connect.example.com");

    await expect(service.resolve("does-not-exist")).resolves.toBeUndefined();
  });

  it("resolves undefined once the link has expired", async () => {
    const service = createService("https://connect.example.com");

    const link = await service.create("https://api.example.com/auth?token=***", { ttlMs: 1 });
    const token = link.split("/r/")[1];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(service.resolve(token)).resolves.toBeUndefined();
  });

  it("rejects a local-network target URL", async () => {
    const service = createService("https://connect.example.com");

    const localUrl = "http://localhost:8080/auth?token=abc123";
    let caught: unknown;
    try {
      await service.create(localUrl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ShortLinkError);
  });

  it("rejects an unparseable target URL", async () => {
    const service = createService("https://connect.example.com");

    let caught: unknown;
    try {
      await service.create("not a url");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ShortLinkError);
  });
});
