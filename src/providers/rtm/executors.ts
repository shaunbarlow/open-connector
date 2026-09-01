import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";
import type { RtmActionContext } from "./runtime.ts";

import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { rtmActionHandlers, validateRtmCredential } from "./runtime.ts";

const service = "rtm";

export const executors: ProviderExecutors = defineProviderExecutors<RtmActionContext>({
  service,
  handlers: rtmActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<RtmActionContext> {
    const credential = await context.getCredential(service);
    if (credential?.authType !== "custom_credential") {
      throw new ProviderRequestError(401, "Configure Remember The Milk custom credentials first.");
    }
    return {
      apiKey: credential.values.apiKey,
      sharedSecret: credential.values.sharedSecret,
      authToken: credential.values.authToken || undefined,
      fetcher,
      signal: context.signal,
      updateCredential: context.updateCredential,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  customCredential: validateRtmCredential,
};
