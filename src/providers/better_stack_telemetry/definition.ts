import type { ProviderDefinition } from "../../core/types.ts";

import { betterStackTelemetryActions } from "./actions.ts";

const service = "better_stack_telemetry";

export const provider: ProviderDefinition = {
  service,
  displayName: "Better Stack Telemetry",
  categories: ["Developer Tools", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "host",
          label: "ClickHouse Host",
          inputType: "text",
          required: true,
          secret: false,
          placeholder: "eu-nbg-2-connect.betterstackdata.com",
          description:
            "Hostname of your Better Stack Telemetry SQL API connection, without scheme or port. Find it in Better Stack > Telemetry > Integrations > SQL API > your connection's Host field: https://betterstack.com/docs/logs/query-api/connect-remotely/.",
        },
        {
          key: "username",
          label: "Username",
          inputType: "text",
          required: true,
          secret: false,
          description:
            "Username for a Better Stack Telemetry SQL API (ClickHouse HTTP) connection, created in Integrations > SQL API.",
        },
        {
          key: "password",
          label: "Password",
          inputType: "password",
          required: true,
          secret: true,
          description:
            "Password shown once when the SQL API connection was created. Store it now; Better Stack does not show it again.",
        },
        {
          key: "apiToken",
          label: "Telemetry API Token",
          inputType: "password",
          required: true,
          secret: true,
          placeholder: "bst_...",
          description:
            "Better Stack Telemetry API token used with the Authorization Bearer header for source and metric discovery. This is usually a different token than the SQL API username/password above. Create it from Better Stack > Telemetry > API tokens: https://betterstack.com/docs/logs/api/getting-started/.",
        },
      ],
      testAction: {
        actionName: "ping",
        input: {},
      },
    },
  ],
  homepageUrl: "https://betterstack.com/docs/logs/query-api/connect-remotely/",
  actions: betterStackTelemetryActions,
};
