import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "better_stack_telemetry";

const fromField = s.dateTime("Inclusive start of the time range (ISO 8601). Defaults to no lower bound when omitted.");
const toField = s.dateTime("Inclusive end of the time range (ISO 8601). Defaults to now when omitted.");
const granularityField = s.stringEnum(
  "Metrics table granularity. 'raw' is highest resolution (15 second intervals); '5m' and '1h' are pre-aggregated buckets, best for wide time ranges.",
  ["raw", "5m", "1h"],
);
const rowSchema = s.unknownObject("A single result row returned by Better Stack Telemetry, keyed by selected column.");

const pageField = s.positiveInteger("Page number to return.");
const perPageField = s.positiveInteger("Number of records to return per page. Better Stack allows up to 50.", {
  maximum: 50,
});
const sourceIdField = s.nonEmptyString(
  "The Better Stack Telemetry source ID (the numeric 'id' field from list_sources or get_source, not its name or table_name). The SQL API host and table_name prefix for this source are both resolved automatically from Telemetry API discovery; call list_sources first if you do not already have the ID.",
);
const resolvedSourceSchema = s.object(
  "Which Better Stack Telemetry source, ClickHouse host, and table prefix this action actually queried, resolved from Telemetry API discovery rather than a fixed connection field.",
  {
    sourceId: s.string("The source ID that was queried."),
    name: s.string("The source's human-readable name."),
    tableName: s.string("The resolved table_name prefix used to build logs/metrics/s3 table references."),
    dataRegion: s.string("The source's data_region, for example 'eu-nbg-2'."),
    sqlApiHost: s.string(
      "The ClickHouse SQL API host derived from dataRegion, for example 'eu-nbg-2-connect.betterstackdata.com'.",
    ),
  },
  { required: ["sourceId", "name", "tableName", "dataRegion", "sqlApiHost"] },
);
const paginationSchema = s.object(
  "Pagination links returned by Better Stack, following the JSON:API convention.",
  {
    first: s.nullableString("Link to the first page."),
    last: s.nullableString("Link to the last page."),
    prev: s.nullableString("Link to the previous page, or null on the first page."),
    next: s.nullableString("Link to the next page, or null on the last page."),
  },
  { required: ["first", "last", "prev", "next"] },
);
const customBucketSchema = s.looseObject(
  "Custom S3-compatible storage bucket configuration for a source, when configured.",
  {
    name: s.string("Bucket name."),
    endpoint: s.string("Bucket endpoint URL."),
    access_key_id: s.string("Access key ID stored for the bucket."),
  },
);
const sourceAttributesSchema = s.looseObject("Attributes returned for a Better Stack Telemetry source.", {
  source_group_id: s.nullable(s.integer("Source group this source belongs to, when grouped.")),
  team_id: s.integer("Owning Better Stack team ID."),
  team_name: s.string("Owning Better Stack team name."),
  name: s.string("Human-readable source name."),
  platform: s.string("Source platform/integration type, for example 'nginx' or 'javascript'."),
  table_name: s.string("Base table name used when referencing this source's data in SQL API queries."),
  token: s.string("Source ingest token."),
  ingesting_paused: s.boolean("Whether ingestion is currently paused for this source."),
  ingesting_host: s.string("Hostname this source ingests data through."),
  created_at: s.dateTime("Timestamp when the source was created."),
  updated_at: s.dateTime("Timestamp when the source was last updated."),
  logs_retention: s.integer("Log retention in days."),
  metrics_retention: s.integer("Metric retention in days."),
  live_tail_pattern: s.nullableString("Live tail display pattern configured for this source."),
  data_region: s.string("Data region this source's data is stored in, for example 'eu-nbg-2'."),
  sql_api_host: s.optional(
    s.string(
      "ClickHouse SQL API host derived from data_region, for example 'eu-nbg-2-connect.betterstackdata.com'. Better Stack does not return this field directly; it is computed here so you do not need to guess the per-region hostname pattern yourself. Actions that query the SQL API (run_query, search_logs, query_metrics) resolve and use this host automatically when you pass sourceId, so you normally do not need to read this field directly.",
    ),
  ),
  custom_bucket: s.nullable(customBucketSchema),
  vrl_transformation_logs: s.nullableString("Vector Remap Language transformation applied to ingested logs."),
  vrl_transformation_spans: s.nullableString("Vector Remap Language transformation applied to ingested spans."),
});
const sourceSchema = s.object(
  "A Better Stack Telemetry source resource.",
  {
    id: s.string("Source ID."),
    type: s.string("Resource type returned by Better Stack, usually 'source'."),
    attributes: sourceAttributesSchema,
  },
  { required: ["id", "type", "attributes"] },
);
const metricAttributesSchema = s.looseObject("Attributes returned for a Better Stack Telemetry metric.", {
  name: s.string("Metric or label column name."),
  sql_expression: s.string("SQL expression backing this metric column."),
  aggregations: s.stringArray("Aggregate combinators available for this metric, for example ['anyLast', 'count'].", {
    itemDescription: "An aggregate combinator name.",
  }),
  type: s.string("Metric storage type, for example 'string_low_cardinality' or 'int64_delta'."),
});
const metricSchema = s.object(
  "A Better Stack Telemetry metric or label resource.",
  {
    id: s.string("Metric ID."),
    type: s.string("Resource type returned by Better Stack, usually 'metric'."),
    attributes: metricAttributesSchema,
  },
  { required: ["id", "type", "attributes"] },
);
const sourceGroupAttributesSchema = s.looseObject("Attributes returned for a Better Stack Telemetry source group.", {
  id: s.integer("Numeric source group ID."),
  name: s.string("Source group name."),
  created_at: s.dateTime("Timestamp when the source group was created."),
  updated_at: s.dateTime("Timestamp when the source group was last updated."),
  sort_index: s.nullable(s.integer("Display sort order among source groups.")),
  team_name: s.string("Owning Better Stack team name."),
});
const sourceGroupSchema = s.object(
  "A Better Stack Telemetry source group resource.",
  {
    id: s.string("Source group ID."),
    type: s.string("Resource type returned by Better Stack, usually 'source_group'."),
    attributes: sourceGroupAttributesSchema,
  },
  { required: ["id", "type", "attributes"] },
);

const pingOutput = s.actionOutput({
  ok: s.boolean(
    "Whether the Telemetry API token is reachable, and (when at least one source exists) whether the SQL API connection to that source's derived ClickHouse host also succeeded.",
  ),
  message: s.string("Human-readable status message."),
});

const runQueryInput = s.actionInput(
  {
    sourceId: sourceIdField,
    sql: s.nonEmptyString(
      "A single read-only ClickHouse SQL statement to run against the resolved source. Must start with SELECT or WITH. Reference this source's own tables using its resolved table_name prefix, for example remote(<table_name>_logs) or s3Cluster(primary, <table_name>_s3); call get_source first if you need the exact table_name string. Do not include a FORMAT clause; JSONEachRow is applied automatically.",
    ),
    maxRows: s.positiveInteger("Maximum number of result rows to return. Defaults to 1000, capped at 10000.", {
      maximum: 10000,
    }),
  },
  ["sourceId", "sql"],
);
const runQueryOutput = s.actionOutput({
  rows: s.array("Parsed result rows.", rowSchema),
  rowCount: s.nonNegativeInteger("Number of rows returned."),
  truncated: s.boolean("Whether the result was cut off at maxRows."),
  resolvedSource: resolvedSourceSchema,
});

const searchLogsInput = s.actionInput(
  {
    sourceId: sourceIdField,
    searchText: s.nonEmptyString(
      "Case-insensitive substring to search for within the raw log line. Omit to return the most recent logs unfiltered.",
    ),
    from: fromField,
    to: toField,
    includeHistorical: s.boolean(
      "Whether to also search cold S3 storage in addition to recent hot storage. Defaults to true. Set to false for a faster query limited to recent logs.",
    ),
    limit: s.positiveInteger("Maximum number of log lines to return. Defaults to 100, capped at 5000.", {
      maximum: 5000,
    }),
  },
  ["sourceId"],
);
const logLineSchema = s.object(
  "A single Better Stack log line.",
  {
    dt: s.dateTime("Timestamp the log line was recorded."),
    raw: s.string("Raw log line content as stored by Better Stack, typically JSON-encoded."),
    parsed: s.nullable(s.unknownObject("The raw field parsed as JSON, when it was valid JSON.")),
  },
  { required: ["dt", "raw", "parsed"] },
);
const searchLogsOutput = s.actionOutput({
  logs: s.array("Matching log lines ordered from newest to oldest.", logLineSchema),
  rowCount: s.nonNegativeInteger("Number of log lines returned."),
  resolvedSource: resolvedSourceSchema,
});

const queryMetricsInput = s.actionInput(
  {
    sourceId: sourceIdField,
    granularity: granularityField,
    selectExpressions: s.array(
      "SQL expressions for the SELECT list, evaluated against your metrics table. Must reference only columns and aggregate combinators that exist for your metrics, for example ['label(\\'route\\') AS route', 'avgMerge(value_avg) AS avg_value']. At least one expression is required. Call list_metrics first to see which columns and aggregations exist for this source.",
      s.nonEmptyString("A single SELECT expression, optionally aliased with AS."),
      { minItems: 1 },
    ),
    metricName: s.nonEmptyString(
      "Optional exact metric name to filter on (the 'name' column). Omit to include all metrics matched by other filters.",
    ),
    groupByExpressions: s.array(
      "Optional SQL expressions to GROUP BY, evaluated identically to selectExpressions.",
      s.nonEmptyString("A single GROUP BY expression."),
    ),
    from: fromField,
    to: toField,
    limit: s.positiveInteger("Maximum number of result rows to return. Defaults to 1000, capped at 10000.", {
      maximum: 10000,
    }),
  },
  ["sourceId", "granularity", "selectExpressions"],
);
const queryMetricsOutput = s.actionOutput({
  rows: s.array("Result rows produced by the supplied select and group by expressions.", rowSchema),
  rowCount: s.nonNegativeInteger("Number of rows returned."),
  table: s.string("The fully-qualified ClickHouse table function this query read from."),
  resolvedSource: resolvedSourceSchema,
});

const listSourcesInput = s.actionInput({
  page: pageField,
  perPage: perPageField,
});
const listSourcesOutput = s.actionOutput({
  sources: s.array("Sources belonging to your team.", sourceSchema),
  pagination: paginationSchema,
});

const getSourceInput = s.actionInput({ sourceId: sourceIdField }, ["sourceId"]);
const getSourceOutput = s.actionOutput({ source: sourceSchema });

const listMetricsInput = s.actionInput(
  {
    sourceId: sourceIdField,
    page: pageField,
    perPage: perPageField,
  },
  ["sourceId"],
);
const listMetricsOutput = s.actionOutput({
  metrics: s.array("Metrics and labels available for the source.", metricSchema),
  pagination: paginationSchema,
});

const listSourceGroupsInput = s.actionInput({
  page: pageField,
  perPage: perPageField,
});
const listSourceGroupsOutput = s.actionOutput({
  sourceGroups: s.array("Source groups belonging to your team.", sourceGroupSchema),
  pagination: paginationSchema,
});

export const betterStackTelemetryActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "ping",
    description: "Verify the Better Stack Telemetry SQL API connection is reachable and credentials are valid.",
    requiredScopes: [],
    inputSchema: s.actionInput({}),
    outputSchema: pingOutput,
  }),
  defineProviderAction(service, {
    name: "list_sources",
    description:
      "List Better Stack Telemetry sources for your team, including each source's id, table_name, and data_region. Pass a source's id as sourceId to run_query, search_logs, or query_metrics; those actions resolve table_name and the correct regional SQL API host for you, so you do not need to read table_name/data_region yourself in the normal case.",
    requiredScopes: [],
    followUpActions: [
      "better_stack_telemetry.search_logs",
      "better_stack_telemetry.query_metrics",
      "better_stack_telemetry.list_metrics",
    ],
    inputSchema: listSourcesInput,
    outputSchema: listSourcesOutput,
  }),
  defineProviderAction(service, {
    name: "get_source",
    description:
      "Get a single Better Stack Telemetry source by ID, including its table_name, data_region, and derived sql_api_host.",
    requiredScopes: [],
    followUpActions: [
      "better_stack_telemetry.search_logs",
      "better_stack_telemetry.query_metrics",
      "better_stack_telemetry.run_query",
    ],
    inputSchema: getSourceInput,
    outputSchema: getSourceOutput,
  }),
  defineProviderAction(service, {
    name: "list_metrics",
    description:
      "List the metrics and labels available for a Better Stack Telemetry source, including the SQL expression and aggregate combinators for each, useful before calling query_metrics.",
    requiredScopes: [],
    followUpActions: ["better_stack_telemetry.query_metrics"],
    inputSchema: listMetricsInput,
    outputSchema: listMetricsOutput,
  }),
  defineProviderAction(service, {
    name: "list_source_groups",
    description: "List Better Stack Telemetry source groups for your team.",
    requiredScopes: [],
    inputSchema: listSourceGroupsInput,
    outputSchema: listSourceGroupsOutput,
  }),
  defineProviderAction(service, {
    name: "run_query",
    description:
      "Run a single read-only SQL statement against your Better Stack Telemetry SQL API connection. Use this for anything the convenience actions do not cover; you are responsible for referencing correct table and column names for your own sources.",
    requiredScopes: [],
    inputSchema: runQueryInput,
    outputSchema: runQueryOutput,
  }),
  defineProviderAction(service, {
    name: "search_logs",
    description:
      "Search recent (and optionally historical) log lines for a Better Stack Telemetry source, with optional text and time-range filters.",
    requiredScopes: [],
    inputSchema: searchLogsInput,
    outputSchema: searchLogsOutput,
  }),
  defineProviderAction(service, {
    name: "query_metrics",
    description:
      "Query a Better Stack Telemetry metrics table (raw, 5-minute, or 1-hour pre-aggregated) for a source, with caller-supplied select and group-by expressions and a safely parameterized time range.",
    requiredScopes: [],
    inputSchema: queryMetricsInput,
    outputSchema: queryMetricsOutput,
  }),
];
