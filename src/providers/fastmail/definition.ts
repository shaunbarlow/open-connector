import type { ProviderDefinition } from "../../core/types.ts";

import { fastmailActions } from "./actions.ts";

export const provider: ProviderDefinition = {
  service: "fastmail",
  displayName: "Fastmail",
  description: "Fastmail mail access through its JMAP API.",
  categories: ["Communication", "Productivity"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "JMAP API Token",
      placeholder: "Fastmail API token",
      description: "A revocable Fastmail API token with JMAP mail access.",
    },
  ],
  homepageUrl: "https://www.fastmail.com/dev/",
  actions: fastmailActions,
};
