import type { ProviderDefinition } from "../../core/types.ts";

import { rtmActions } from "./actions.ts";

const service = "rtm";

export const provider: ProviderDefinition = {
  service,
  displayName: "Remember The Milk",
  categories: ["Productivity"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "apiKey",
          label: "API Key",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "Remember The Milk API key",
          description: "API key from https://www.rememberthemilk.com/services/api/keys.rtm.",
        },
        {
          key: "sharedSecret",
          label: "Shared Secret",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "Remember The Milk shared secret",
          description: "Shared secret issued alongside the API key. Used to sign every request.",
        },
        {
          key: "authToken",
          label: "Auth Token",
          inputType: "password",
          required: false,
          secret: true,
          placeholder: "Obtained via start_auth / complete_auth",
          description:
            "Leave blank when first creating the connection. Run the start_auth action, open the returned URL, authorize the app, then run complete_auth with the returned frob. complete_auth saves the token here automatically when the runtime supports it; otherwise paste the returned token into this field.",
        },
      ],
      testAction: {
        actionName: "check_auth",
        input: {},
      },
    },
  ],
  homepageUrl: "https://www.rememberthemilk.com",
  actions: rtmActions,
};
