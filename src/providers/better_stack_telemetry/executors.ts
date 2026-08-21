import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
} from "../../core/types.ts";
import type { BetterStackTelemetryContext } from "./runtime.ts";

import { optionalString } from "../../core/cast.ts";
import {
  createProviderFetch,
  defineProviderExecutors,
  ProviderRequestError,
  requireCustomCredential,
} from "../provider-runtime.ts";
import {
  betterStackTelemetryActionHandlers,
  buildBetterStackTelemetryAuthorization,
  normalizeBetterStackTelemetryHost,
  validateBetterStackTelemetryCredential,
} from "./runtime.ts";

const service = "better_stack_telemetry";

export const executors: ProviderExecutors = defineProviderExecutors<BetterStackTelemetryContext>({
  service,
  handlers: betterStackTelemetryActionHandlers,
  async createContext(context: ExecutionContext, fetcher): Promise<BetterStackTelemetryContext> {
    const credential = await requireCustomCredential(context, service);
    return {
      host: normalizeBetterStackTelemetryHost(credential.values.host),
      authorization: buildBetterStackTelemetryAuthorization(
        requireField(credential.values.username, "username"),
        requireField(credential.values.password, "password"),
      ),
      apiToken: requireField(credential.values.apiToken, "apiToken"),
      fetcher,
      signal: context.signal,
    };
  },
});

export const credentialValidators: CredentialValidators = {
  async customCredential(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    const guardedFetcher = createProviderFetch({ fetch: fetcher });
    const context: BetterStackTelemetryContext = {
      host: normalizeBetterStackTelemetryHost(input.values.host),
      authorization: buildBetterStackTelemetryAuthorization(
        requireField(input.values.username, "username"),
        requireField(input.values.password, "password"),
      ),
      apiToken: requireField(input.values.apiToken, "apiToken"),
      fetcher: guardedFetcher,
      signal,
    };
    return validateBetterStackTelemetryCredential(context);
  },
};

function requireField(value: unknown, name: string): string {
  const resolved = optionalString(value)?.trim();
  if (!resolved) {
    throw new ProviderRequestError(400, `${name} is required`);
  }
  return resolved;
}
