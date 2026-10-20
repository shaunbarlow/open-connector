import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "fastmail";
const emailId = s.string({ minLength: 1, description: "Fastmail JMAP email ID." });
const threadId = s.string({ minLength: 1, description: "Fastmail JMAP thread ID." });
const mailboxId = s.string({ minLength: 1, description: "Fastmail JMAP mailbox ID." });
const blobId = s.string({ minLength: 1, description: "Fastmail JMAP blob ID." });
const jmapObject = s.record(true, { description: "JMAP object returned by Fastmail." });
const address = s.object(
  {
    email: s.string({ minLength: 1, description: "Email address." }),
    name: s.string({ description: "Display name." }),
  },
  { required: ["email"], description: "Email address." },
);
const addresses = s.array(address, { description: "Email recipients." });
const mailScope = ["urn:ietf:params:jmap:mail"];
const submissionScope = ["urn:ietf:params:jmap:submission"];

function action(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[],
  outputSchema: JsonSchema,
  requiredScopes = mailScope,
): ActionDefinition {
  return defineProviderAction(service, {
    name,
    description,
    requiredScopes,
    inputSchema: s.object(properties, { required, description: "Fastmail action input." }),
    outputSchema,
  });
}

export const fastmailActions: ActionDefinition[] = [
  action("get_profile", "Get the connected Fastmail JMAP account profile.", {}, [], jmapObject, [
    "urn:ietf:params:jmap:core",
  ]),
  action(
    "list_mailboxes",
    "List the connected Fastmail mailboxes.",
    {},
    [],
    s.object({ mailboxes: s.array(jmapObject) }, { required: ["mailboxes"] }),
  ),
  action(
    "search_emails",
    "Search Fastmail mail using a JMAP Email/query filter and return hydrated emails.",
    { filter: s.record(true), limit: s.integer({ minimum: 1, maximum: 100 }), position: s.integer({ minimum: 0 }) },
    [],
    s.object(
      { emails: s.array(jmapObject), queryState: s.string(), total: s.integer() },
      { required: ["emails", "queryState", "total"] },
    ),
  ),
  action(
    "list_emails",
    "List Fastmail emails, optionally in a mailbox.",
    { mailboxId, limit: s.integer({ minimum: 1, maximum: 100 }), position: s.integer({ minimum: 0 }) },
    [],
    s.object(
      { emails: s.array(jmapObject), queryState: s.string(), total: s.integer() },
      { required: ["emails", "queryState", "total"] },
    ),
  ),
  action(
    "get_email",
    "Get a Fastmail email by JMAP ID.",
    { emailId },
    ["emailId"],
    s.object({ email: jmapObject }, { required: ["email"] }),
  ),
  action(
    "get_thread",
    "Get all emails in a Fastmail thread.",
    { threadId },
    ["threadId"],
    s.object({ emails: s.array(jmapObject) }, { required: ["emails"] }),
  ),
  action(
    "set_email",
    "Update one email's mailbox membership or keywords using JMAP Email/set.",
    { emailId, mailboxIds: s.record(s.boolean()), keywords: s.record(s.boolean()) },
    ["emailId"],
    jmapObject,
  ),
  action(
    "update_email",
    "Mark an email read or flagged, and optionally move it to a mailbox.",
    { emailId, isRead: s.boolean(), isFlagged: s.boolean(), mailboxId },
    ["emailId"],
    jmapObject,
  ),
  action(
    "archive_email",
    "Archive an email by removing it from the Inbox mailbox.",
    { emailId },
    ["emailId"],
    jmapObject,
  ),
  action(
    "create_draft",
    "Create a Fastmail draft.",
    { to: addresses, cc: addresses, bcc: addresses, subject: s.string(), body: s.string(), mailboxId },
    ["to", "subject", "body"],
    s.object({ draftId: emailId, email: jmapObject }, { required: ["draftId", "email"] }),
  ),
  action(
    "send_email",
    "Send an email through Fastmail JMAP.",
    { to: addresses, cc: addresses, bcc: addresses, subject: s.string(), body: s.string() },
    ["to", "subject", "body"],
    s.object({ emailId, submissionId: s.string() }, { required: ["emailId", "submissionId"] }),
    [...mailScope, ...submissionScope],
  ),
  action(
    "reply_email",
    "Reply to a Fastmail email while preserving JMAP reply threading fields.",
    { emailId, to: addresses, cc: addresses, bcc: addresses, body: s.string() },
    ["emailId", "body"],
    s.object({ emailId, submissionId: s.string() }, { required: ["emailId", "submissionId"] }),
    [...mailScope, ...submissionScope],
  ),
  action(
    "download_attachment",
    "Download a JMAP blob attachment into connector file transit.",
    { blobId, name: s.string(), type: s.string() },
    ["blobId", "name", "type"],
    s.object({ attachment: jmapObject }, { required: ["attachment"] }),
  ),
];
