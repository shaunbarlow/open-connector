import type { IShortLinkStore } from "./storage/short-link-store.ts";

import { randomBytes } from "node:crypto";
import { assertPublicHttpUrl } from "../core/request.ts";

const defaultTtlMs = 15 * 60 * 1000;
const maxTtlMs = 24 * 60 * 60 * 1000;
const tokenBytes = 24;

export class ShortLinkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ShortLinkServiceOptions {
  store: IShortLinkStore;
  /** Public base URL this runtime is reachable at, e.g. `https://connect.example.com`. */
  publicOrigin: string;
}

/**
 * Issues and resolves opaque, expiring public redirect links.
 *
 * Backs `ExecutionContext.createShortLink`: a provider action can register a
 * sensitive-looking URL (one embedding an API key, signed request, etc.) once
 * and hand back a link containing only an unguessable token, so returning it
 * to a calling agent does not risk a host redacting the real destination
 * before a human gets to open it.
 */
export class ShortLinkService {
  private readonly store: IShortLinkStore;
  private readonly publicOrigin: string;

  constructor(options: ShortLinkServiceOptions) {
    this.store = options.store;
    this.publicOrigin = options.publicOrigin.replace(/\/+$/, "");
  }

  /** Register `url` and return the public link that redirects to it. */
  async create(url: string, options: { ttlMs?: number } = {}): Promise<string> {
    assertPublicHttpUrl(url, {
      fieldName: "Redirect URL",
      createError: (message) => new ShortLinkError("invalid_input", message),
    });
    const ttlMs = clampTtlMs(options.ttlMs);
    const now = Date.now();
    const token = randomBytes(tokenBytes).toString("base64url");
    await this.store.add({
      token,
      url,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    });
    return `${this.publicOrigin}/r/${token}`;
  }

  /** Resolve `token` to its target URL, or undefined when missing/expired. */
  async resolve(token: string): Promise<string | undefined> {
    return this.store.resolve(token);
  }
}

function clampTtlMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return defaultTtlMs;
  }
  return Math.min(requested, maxTtlMs);
}
