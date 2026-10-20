import type { CredentialValidationResult } from "../../core/types.ts";
import type { ApiKeyProviderContext } from "../provider-runtime.ts";

import { ProviderRequestError } from "../provider-runtime.ts";

const sessionUrl = "https://api.fastmail.com/jmap/session";
const coreCapability = "urn:ietf:params:jmap:core";
const mailCapability = "urn:ietf:params:jmap:mail";
const submissionCapability = "urn:ietf:params:jmap:submission";

interface JmapSession {
  apiUrl: string;
  downloadUrl?: string;
  primaryAccounts?: Record<string, string>;
  accounts?: Record<string, { name?: string; isPersonal?: boolean }>;
}

interface JmapResponse {
  methodResponses: Array<[string, Record<string, unknown>, string]>;
}

interface FastmailContext extends ApiKeyProviderContext {
  transitFiles?: ApiKeyProviderContext["transitFiles"];
}

type FastmailActionHandler = (input: Record<string, unknown>, context: FastmailContext) => Promise<unknown>;

export const fastmailActionHandlers: Record<string, FastmailActionHandler> = {
  async get_profile(_input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const accountId = account(session, mailCapability);
    return { accountId, accounts: session.accounts ?? {}, primaryAccounts: session.primaryAccounts ?? {} };
  },
  async list_mailboxes(_input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const response = await call(session, context, [
      ["Mailbox/get", { accountId: account(session, mailCapability) }, "mailboxes"],
    ]);
    return { mailboxes: list(response, "mailboxes") };
  },
  async search_emails(input, context) {
    return queryEmails(input, context, optionalRecord(input.filter));
  },
  async list_emails(input, context) {
    const mailboxId = optionalString(input.mailboxId);
    return queryEmails(input, context, mailboxId ? { inMailbox: mailboxId } : undefined);
  },
  async get_email(input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const response = await call(session, context, [
      ["Email/get", { accountId: account(session, mailCapability), ids: [requiredString(input, "emailId")] }, "email"],
    ]);
    const email = list(response, "email")[0];
    if (!email) throw new ProviderRequestError(404, "Fastmail email was not found.");
    return { email };
  },
  async get_thread(input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const accountId = account(session, mailCapability);
    const query = await call(session, context, [
      ["Email/query", { accountId, filter: { inThread: requiredString(input, "threadId") }, limit: 100 }, "query"],
    ]);
    const ids = stringList(methodArguments(query, "query").ids);
    if (ids.length === 0) return { emails: [] };
    const emails = await call(session, context, [["Email/get", { accountId, ids }, "emails"]]);
    return { emails: list(emails, "emails") };
  },
  async set_email(input, context) {
    const patch: Record<string, unknown> = {};
    if (input.mailboxIds !== undefined) patch.mailboxIds = input.mailboxIds;
    if (input.keywords !== undefined) patch.keywords = input.keywords;
    if (Object.keys(patch).length === 0) throw new ProviderRequestError(400, "Specify mailboxIds or keywords.");
    return updateEmail(context, requiredString(input, "emailId"), patch);
  },
  async update_email(input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const accountId = account(session, mailCapability);
    const emailId = requiredString(input, "emailId");
    const email = await getEmail(session, context, accountId, emailId);
    const patch: Record<string, unknown> = {};
    const keywords = { ...objectOrEmpty(email.keywords) };
    if (typeof input.isRead === "boolean") setKeyword(keywords, "$seen", input.isRead);
    if (typeof input.isFlagged === "boolean") setKeyword(keywords, "$flagged", input.isFlagged);
    if (input.isRead !== undefined || input.isFlagged !== undefined) patch.keywords = keywords;
    const destination = optionalString(input.mailboxId);
    if (destination) patch.mailboxIds = { [destination]: true };
    if (Object.keys(patch).length === 0)
      throw new ProviderRequestError(400, "Specify isRead, isFlagged, or mailboxId.");
    return updateEmailWithSession(session, context, accountId, emailId, patch);
  },
  async archive_email(input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const accountId = account(session, mailCapability);
    const emailId = requiredString(input, "emailId");
    const email = await getEmail(session, context, accountId, emailId);
    const mailboxIds = { ...objectOrEmpty(email.mailboxIds) };
    const inboxId = await findRoleMailboxId(session, context, accountId, "inbox");
    if (!inboxId || !mailboxIds[inboxId]) return { updated: {} };
    delete mailboxIds[inboxId];
    return updateEmailWithSession(session, context, accountId, emailId, { mailboxIds });
  },
  async create_draft(input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const accountId = account(session, mailCapability);
    const draftMailboxId =
      optionalString(input.mailboxId) ?? (await findRoleMailboxId(session, context, accountId, "drafts"));
    if (!draftMailboxId) throw new ProviderRequestError(502, "Fastmail did not return a Drafts mailbox.");
    const email = composeEmail(input, await sender(session, context, accountId), draftMailboxId);
    const response = await call(session, context, [["Email/set", { accountId, create: { draft: email } }, "draft"]]);
    const created = objectOrEmpty(methodArguments(response, "draft").created);
    const draft = objectOrEmpty(created.draft);
    const id = optionalString(draft.id);
    if (!id) throw new ProviderRequestError(502, "Fastmail did not return a draft ID.");
    return { draftId: id, email: draft };
  },
  async send_email(input, context) {
    return submitEmail(input, context);
  },
  async reply_email(input, context) {
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    const accountId = account(session, mailCapability);
    const original = await getEmail(session, context, accountId, requiredString(input, "emailId"));
    const reply = {
      ...input,
      to: input.to ?? original.replyTo ?? original.from,
      subject: replySubject(optionalString(original.subject)),
    };
    return submitEmail(reply, context, session, accountId, original);
  },
  async download_attachment(input, context) {
    if (!context.transitFiles)
      throw new ProviderRequestError(501, "Connector file transit is not available for this request.");
    const session = await getSession(context.apiKey, context.fetcher, context.signal);
    if (!session.downloadUrl) throw new ProviderRequestError(502, "Fastmail did not advertise a JMAP download URL.");
    const name = requiredString(input, "name");
    const type = requiredString(input, "type");
    const url = expandDownloadUrl(
      session.downloadUrl,
      account(session, mailCapability),
      requiredString(input, "blobId"),
      name,
      type,
    );
    const response = await context.fetcher(url, { headers: authorization(context.apiKey), signal: context.signal });
    if (!response.ok) throw new ProviderRequestError(response.status, "Fastmail attachment download failed.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > context.transitFiles.maxBytes)
      throw new ProviderRequestError(413, "Fastmail attachment exceeds the connector file limit.");
    const upload = await context.transitFiles.create(new File([bytes], name, { type }));
    return { attachment: upload };
  },
};

export async function validateFastmailCredential(
  input: Record<string, string>,
  fetcher: typeof fetch,
): Promise<CredentialValidationResult> {
  const session = await getSession(input.apiKey, fetcher);
  const accountId = account(session, mailCapability);
  return { profile: { accountId, displayName: session.accounts?.[accountId]?.name ?? "Fastmail" } };
}

async function queryEmails(
  input: Record<string, unknown>,
  context: FastmailContext,
  filter?: Record<string, unknown>,
): Promise<unknown> {
  const session = await getSession(context.apiKey, context.fetcher, context.signal);
  const accountId = account(session, mailCapability);
  const query = await call(session, context, [
    ["Email/query", { accountId, filter, limit: limit(input), position: position(input) }, "query"],
  ]);
  const args = methodArguments(query, "query");
  const ids = stringList(args.ids);
  if (ids.length === 0)
    return { emails: [], queryState: optionalString(args.queryState) ?? "", total: numberOrZero(args.total) };
  const emails = await call(session, context, [["Email/get", { accountId, ids }, "emails"]]);
  return {
    emails: list(emails, "emails"),
    queryState: optionalString(args.queryState) ?? "",
    total: numberOrZero(args.total),
  };
}

async function submitEmail(
  input: Record<string, unknown>,
  context: FastmailContext,
  existingSession?: JmapSession,
  existingAccountId?: string,
  replyTo?: Record<string, unknown>,
): Promise<unknown> {
  const session = existingSession ?? (await getSession(context.apiKey, context.fetcher, context.signal));
  const accountId = existingAccountId ?? account(session, mailCapability);
  const email = composeEmail(input, await sender(session, context, accountId));
  if (replyTo) {
    const messageId = optionalString(replyTo.messageId);
    if (messageId) email.inReplyTo = [messageId];
    const references = stringList(replyTo.references);
    if (messageId) references.push(messageId);
    if (references.length) email.references = references;
  }
  const response = await call(session, context, [
    ["Email/set", { accountId, create: { email } }, "email"],
    [
      "EmailSubmission/set",
      {
        accountId: account(session, submissionCapability),
        create: { submission: { emailId: "#email", identityId: await identityId(session, context, accountId) } },
      },
      "submission",
    ],
  ]);
  const createdEmail = objectOrEmpty(objectOrEmpty(methodArguments(response, "email").created).email);
  const createdSubmission = objectOrEmpty(objectOrEmpty(methodArguments(response, "submission").created).submission);
  const emailId = optionalString(createdEmail.id);
  const submissionId = optionalString(createdSubmission.id);
  if (!emailId || !submissionId) throw new ProviderRequestError(502, "Fastmail did not confirm email submission.");
  return { emailId, submissionId };
}

function composeEmail(
  input: Record<string, unknown>,
  from: Record<string, unknown>,
  mailboxId?: string,
): Record<string, unknown> {
  const body = requiredString(input, "body");
  const email: Record<string, unknown> = {
    from: [from],
    to: addresses(input.to),
    cc: addresses(input.cc),
    bcc: addresses(input.bcc),
    subject: requiredString(input, "subject"),
    bodyValues: { text: { value: body } },
    textBody: [{ partId: "text", type: "text/plain" }],
  };
  if (mailboxId) email.mailboxIds = { [mailboxId]: true };
  return email;
}

async function updateEmail(
  context: FastmailContext,
  emailId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  const session = await getSession(context.apiKey, context.fetcher, context.signal);
  return updateEmailWithSession(session, context, account(session, mailCapability), emailId, patch);
}

function updateEmailWithSession(
  session: JmapSession,
  context: FastmailContext,
  accountId: string,
  emailId: string,
  patch: Record<string, unknown>,
): Promise<unknown> {
  return call(session, context, [["Email/set", { accountId, update: { [emailId]: patch } }, "set"]]);
}

async function getEmail(
  session: JmapSession,
  context: FastmailContext,
  accountId: string,
  emailId: string,
): Promise<Record<string, unknown>> {
  const response = await call(session, context, [["Email/get", { accountId, ids: [emailId] }, "email"]]);
  const email = list(response, "email")[0];
  if (!email) throw new ProviderRequestError(404, "Fastmail email was not found.");
  return email;
}

async function findRoleMailboxId(
  session: JmapSession,
  context: FastmailContext,
  accountId: string,
  role: string,
): Promise<string | undefined> {
  const response = await call(session, context, [["Mailbox/get", { accountId }, "mailboxes"]]);
  return optionalString(list(response, "mailboxes").find((mailbox) => mailbox.role === role)?.id);
}

async function sender(
  session: JmapSession,
  context: FastmailContext,
  accountId: string,
): Promise<Record<string, unknown>> {
  const response = await call(session, context, [["Identity/get", { accountId }, "identities"]]);
  const identity = list(response, "identities")[0];
  if (!identity || !optionalString(identity.email))
    throw new ProviderRequestError(502, "Fastmail did not return a sending identity.");
  return { email: identity.email, name: identity.name };
}

async function identityId(session: JmapSession, context: FastmailContext, accountId: string): Promise<string> {
  const response = await call(session, context, [["Identity/get", { accountId }, "identities"]]);
  const id = optionalString(list(response, "identities")[0]?.id);
  if (!id) throw new ProviderRequestError(502, "Fastmail did not return a sending identity.");
  return id;
}

async function getSession(apiKey: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<JmapSession> {
  const response = await fetcher(sessionUrl, { headers: authorization(apiKey), signal });
  if (!response.ok) throw new ProviderRequestError(response.status, "Fastmail authentication failed.");
  const session = (await response.json()) as JmapSession;
  if (!session.apiUrl) throw new ProviderRequestError(502, "Fastmail returned an invalid JMAP session.");
  return session;
}

function account(session: JmapSession, capability: string): string {
  const accountId =
    session.primaryAccounts?.[capability] ??
    (capability === submissionCapability ? session.primaryAccounts?.[mailCapability] : undefined);
  if (!accountId) throw new ProviderRequestError(400, `Fastmail did not advertise a primary ${capability} account.`);
  return accountId;
}

async function call(
  session: JmapSession,
  context: FastmailContext,
  methodCalls: Array<[string, Record<string, unknown>, string]>,
): Promise<JmapResponse> {
  const using = [coreCapability, mailCapability];
  if (methodCalls.some(([name]) => name.startsWith("EmailSubmission/"))) using.push(submissionCapability);
  const response = await context.fetcher(session.apiUrl, {
    method: "POST",
    headers: { ...authorization(context.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
    signal: context.signal,
  });
  if (!response.ok) throw new ProviderRequestError(response.status, "Fastmail JMAP request failed.");
  const payload = (await response.json()) as JmapResponse;
  const error = payload.methodResponses.find(([name]) => name === "error");
  if (error)
    throw new ProviderRequestError(
      502,
      `Fastmail JMAP error: ${optionalString(error[1].description) ?? optionalString(error[1].type) ?? "unknown error"}`,
    );
  return payload;
}

function methodArguments(response: JmapResponse, callId: string): Record<string, unknown> {
  const method = response.methodResponses.find(([, , id]) => id === callId);
  if (!method) throw new ProviderRequestError(502, `Fastmail did not return JMAP call ${callId}.`);
  return method[1];
}
function list(response: JmapResponse, callId: string): Record<string, unknown>[] {
  return objectList(methodArguments(response, callId).list);
}
function authorization(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input[key]);
  if (!value) throw new ProviderRequestError(400, `${key} is required.`);
  return value;
}
function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function objectOrEmpty(value: unknown): Record<string, unknown> {
  return optionalRecord(value) ?? {};
}
function objectList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(optionalRecord(item)))
    : [];
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function addresses(value: unknown): Record<string, unknown>[] {
  return objectList(value).filter((address) => Boolean(optionalString(address.email)));
}
function limit(input: Record<string, unknown>): number {
  return typeof input.limit === "number" ? input.limit : 25;
}
function position(input: Record<string, unknown>): number {
  return typeof input.position === "number" ? input.position : 0;
}
function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
function setKeyword(keywords: Record<string, unknown>, name: string, enabled: boolean): void {
  if (enabled) keywords[name] = true;
  else delete keywords[name];
}
function replySubject(subject: string | undefined): string {
  return subject?.toLowerCase().startsWith("re:") ? subject : `Re: ${subject ?? ""}`;
}
function expandDownloadUrl(template: string, accountId: string, blobId: string, name: string, type: string): string {
  return template
    .replace("{accountId}", encodeURIComponent(accountId))
    .replace("{blobId}", encodeURIComponent(blobId))
    .replace("{name}", encodeURIComponent(name))
    .replace("{type}", encodeURIComponent(type));
}
