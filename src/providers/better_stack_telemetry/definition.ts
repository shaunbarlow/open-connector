import type { ProviderDefinition } from "../../core/types.ts";

import { betterStackTelemetryActions } from "./actions.ts";

const service = "better_stack_telemetry";

export const provider: ProviderDefinition = {
  service,
  displayName: "Better Stack Telemetry",
  description:
    "Query Better Stack Telemetry logs, spans, and metrics through its ClickHouse SQL API, and discover sources/metrics through its Telemetry API. One SQL API username/password pair authenticates against every regional ClickHouse endpoint for your team, so actions resolve the right endpoint per source automatically instead of requiring a fixed host.",
  categories: ["Developer Tools", "Data"],
  authTypes: ["custom_credential"],
  auth: [
    {
      type: "custom_credential",
      fields: [
        {
          key: "username",
          label: "Username",
          inputType: "text",
          required: true,
          secret: false,
          description:
            "Username for a Better Stack Telemetry SQL API (ClickHouse HTTP) connection, created in Integrations > SQL API. This single username/password pair works against every regional ClickHouse endpoint Better Stack lists for your team (for example eu-nbg-2-connect.betterstackdata.com and us-east-1-connect.betterstackdata.com); no separate host field is needed because actions derive the correct regional endpoint per source automatically.",
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
            "Better Stack Telemetry API token used with the Authorization Bearer header for source and metric discovery (list_sources, get_source, list_metrics, list_source_groups). This is usually a different token than the SQL API username/password above. Every source's data_region and table_name come from this token's discovery calls, and both are required to run SQL API queries (run_query, search_logs, query_metrics) against that source. Create it from Better Stack > Telemetry > API tokens: https://betterstack.com/docs/logs/api/getting-started/.",
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
