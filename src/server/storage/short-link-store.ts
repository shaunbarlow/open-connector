/** A stored short link mapping an opaque token to a target URL. */
export interface ShortLinkRecord {
  token: string;
  url: string;
  createdAt: string;
  expiresAt: string;
}

/** Persistent store for opaque, expiring public redirect links. */
export interface IShortLinkStore {
  /** Persist a new short link. `token` must be unique. */
  add(record: ShortLinkRecord): Promise<void>;
  /**
   * Resolve `token` to its target URL when the link exists and has not
   * expired. Implementations should opportunistically clear expired rows but
   * must not delete the row on a successful resolve — the link may be
   * retried, previewed, or opened more than once before it expires.
   */
  resolve(token: string): Promise<string | undefined>;
}
