import { describe, expect, it, vi } from "vitest";
import { fastmailActionHandlers } from "./runtime-jmap.ts";

const session = {
  apiUrl: "https://api.fastmail.com/jmap/api/",
  downloadUrl: "https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}",
  primaryAccounts: {
    "urn:ietf:params:jmap:mail": "mail-account",
    "urn:ietf:params:jmap:submission": "mail-account",
  },
  accounts: { "mail-account": { name: "Example User" } },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function context(fetcher: typeof fetch) {
  return { apiKey: "test-token", fetcher, signal: undefined };
}

describe("Fastmail JMAP runtime", () => {
  it("queries then hydrates matching emails", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(
        response({ methodResponses: [["Email/query", { ids: ["e1"], queryState: "state", total: 1 }, "query"]] }),
      )
      .mockResolvedValueOnce(
        response({ methodResponses: [["Email/get", { list: [{ id: "e1", subject: "Hello" }] }, "emails"]] }),
      );

    await expect(
      fastmailActionHandlers.search_emails({ filter: { text: "hello" } }, context(fetcher)),
    ).resolves.toEqual({
      emails: [{ id: "e1", subject: "Hello" }],
      queryState: "state",
      total: 1,
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).methodCalls[0]).toEqual([
      "Email/query",
      { accountId: "mail-account", filter: { text: "hello" }, limit: 25, position: 0 },
      "query",
    ]);
  });

  it("creates an email and submits it using JMAP result references", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(
        response({
          methodResponses: [["Identity/get", { list: [{ id: "identity", email: "me@example.test" }] }, "identities"]],
        }),
      )
      .mockResolvedValueOnce(
        response({
          methodResponses: [["Identity/get", { list: [{ id: "identity", email: "me@example.test" }] }, "identities"]],
        }),
      )
      .mockResolvedValueOnce(
        response({
          methodResponses: [
            ["Email/set", { created: { email: { id: "email-id" } } }, "email"],
            ["EmailSubmission/set", { created: { submission: { id: "submission-id" } } }, "submission"],
          ],
        }),
      );

    await expect(
      fastmailActionHandlers.send_email(
        { to: [{ email: "you@example.test" }], subject: "Hi", body: "Body" },
        context(fetcher),
      ),
    ).resolves.toEqual({ emailId: "email-id", submissionId: "submission-id" });
    const payload = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
    expect(payload.using).toContain("urn:ietf:params:jmap:submission");
    expect(payload.methodCalls[1][1].create.submission.emailId).toBe("#email");
  });

  it("returns a provider error for JMAP method errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(response({ methodResponses: [["error", { type: "accountNotFound" }, "mailboxes"]] }));
    await expect(fastmailActionHandlers.list_mailboxes({}, context(fetcher))).rejects.toThrow("accountNotFound");
  });
});
