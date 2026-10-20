import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { fastmailActionHandlers, validateFastmailCredential } from "./runtime-jmap.ts";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors("fastmail", fastmailActionHandlers);

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher }) {
    return validateFastmailCredential({ apiKey: input.apiKey, ...input.values }, fetcher);
  },
};
