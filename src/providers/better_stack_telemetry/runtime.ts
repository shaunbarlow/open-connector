import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { ProviderFetch } from "../provider-runtime.ts";

import { optionalInteger, optionalRecord, optionalString, positiveInteger } from "../../core/cast.ts";
import { createProviderTimeout, ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

const betterStackTelemetryRequestTimeoutMs = 30_000;
const betterStackTelemetryMaxResponseBytes = 25 * 1024 * 1024;
const betterStackTelemetryDefaultRowLimit = 1000;
const betterStackTelemetryMaxRowLimit = 10_000;
const betterStackTelemetryDefaultLogLimit = 100;
const betterStackTelemetryMaxLogLimit = 5000;
const betterStackTelemetryApiBaseUrl = "https://telemetry.betterstack.com";
const betterStackTelemetryDefaultPerPage = 50;
const betterStackTelemetryMaxPerPage = 50;
const sourceTablePattern = /^[A-Za-z0-9_]+$/;
const sqlLeadingKeywordPattern = /^\s*(select|with)\b/i;
const sqlFormatKeywordPattern = /\bformat\s+\w+/i;

export interface BetterStackTelemetryContext {
  authorization: string;
  apiToken: string;
  fetcher: ProviderFetch;
  signal?: AbortSignal;
}

/** A Better Stack Telemetry source resolved for use in SQL API queries. */
export interface ResolvedBetterStackTelemetrySource {
  sourceId: string;
  name: string;
  tableName: string;
  teamId: number;
  dataRegion: string;
  host: string;
}

type BetterStackTelemetryActionHandler = (
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
) => Promise<unknown>;

export const betterStackTelemetryActionHandlers: ProviderActionHandlers<
  "better_stack_telemetry",
  BetterStackTelemetryActionHandler
> = {
  ping(_input, context) {
    return pingBetterStackTelemetry(context);
  },
  run_query(input, context) {
    return runBetterStackTelemetryQuery(input, context);
  },
  search_logs(input, context) {
    return searchBetterStackTelemetryLogs(input, context);
  },
  query_metrics(input, context) {
    return queryBetterStackTelemetryMetrics(input, context);
  },
  list_sources(input, context) {
    return listBetterStackTelemetrySources(input, context);
  },
  get_source(input, context) {
    return getBetterStackTelemetrySource(input, context);
  },
  list_metrics(input, context) {
    return listBetterStackTelemetryMetrics(input, context);
  },
  list_source_groups(input, context) {
    return listBetterStackTelemetrySourceGroups(input, context);
  },
};

/**
 * Build a Better Stack Telemetry SQL API (ClickHouse HTTP) hostname from a
 * source's `data_region`, for example `eu-nbg-2` -> `eu-nbg-2-connect.betterstackdata.com`.
 *
 * One SQL API username/password pair is valid across every regional endpoint
 * for the team (confirmed against the Better Stack dashboard's own "Connect
 * ClickHouse HTTP client" instructions, which list one set of credentials
 * alongside multiple region-specific endpoints). Better Stack does not
 * document this hostname pattern as a stable contract, so treat it as
 * derived/best-effort and prefer discovery (list_sources/get_source) over
 * hardcoding regions.
 */
export function buildBetterStackTelemetryHost(dataRegion: string): string {
  const region = dataRegion.trim();
  if (!region || !/^[a-z0-9][a-z0-9-]*$/i.test(region)) {
    throw new ProviderRequestError(502, "better_stack_telemetry source returned an unexpected data_region value");
  }
  return `${region}-connect.betterstackdata.com`;
}

/**
 * Resolve a source ID to the SQL API table-name prefix and ClickHouse host it
 * lives on, by reading `table_name` and `data_region` from the Telemetry API
 * rather than requiring the caller to know or guess them.
 */
export async function resolveBetterStackTelemetrySource(
  context: BetterStackTelemetryContext,
  sourceId: string,
): Promise<ResolvedBetterStackTelemetrySource> {
  const payload = await requestBetterStackTelemetryApi(
    context,
    `/api/v2/sources/${encodeURIComponent(sourceId)}`,
    {},
    "execute",
  );
  const body = requireObjectPayload(payload, "better_stack_telemetry source response");
  // Unlike the list endpoint, get-a-single-source returns the resource unwrapped, without a top-level data envelope.
  const resource = optionalRecord(body.data) ?? body;
  const attributes = requireObjectPayload(resource.attributes, "better_stack_telemetry source attributes");

  return resolveBetterStackTelemetrySourceFromAttributes(sourceId, attributes);
}

function resolveBetterStackTelemetrySourceFromAttributes(
  sourceId: string,
  attributes: Record<string, unknown>,
): ResolvedBetterStackTelemetrySource {
  const tableName = optionalString(attributes.table_name)?.trim();
  if (!tableName || !sourceTablePattern.test(tableName)) {
    throw new ProviderRequestError(502, "better_stack_telemetry source returned an unexpected table_name value");
  }
  const dataRegion = optionalString(attributes.data_region)?.trim();
  if (!dataRegion) {
    throw new ProviderRequestError(502, "better_stack_telemetry source did not include a data_region");
  }
  const teamId = optionalInteger(attributes.team_id);
  if (teamId === undefined) {
    throw new ProviderRequestError(502, "better_stack_telemetry source did not include a team_id");
  }

  return {
    sourceId,
    name: optionalString(attributes.name) ?? sourceId,
    tableName,
    teamId,
    dataRegion,
    host: buildBetterStackTelemetryHost(dataRegion),
  };
}

/**
 * Build a fully-qualified ClickHouse table reference for a resolved source, including the required
 * `t<team_id>_` prefix. Better Stack's SQL API exposes each team's tables on shared regional clusters
 * distinguished by this prefix; a plain `<table_name>_logs` reference resolves to no cluster at all and
 * fails with `DB::Exception: Requested cluster '<table_name>_logs' not found (CLUSTER_DOESNT_EXIST)` even
 * though the sourceId and credentials are correct. This is not documented by Better Stack; it was reverse
 * engineered from a working `run_query` call and must be applied everywhere a source's tables are referenced.
 */
export function buildBetterStackTelemetryTableName(
  source: Pick<ResolvedBetterStackTelemetrySource, "teamId" | "tableName">,
  suffix: string,
): string {
  return `t${source.teamId}_${source.tableName}${suffix}`;
}

/** Add the derived `sql_api_host` field to a raw source resource's attributes, when data_region is present. */
function enrichBetterStackTelemetrySourceResource(resource: unknown): unknown {
  const record = optionalRecord(resource);
  if (!record) {
    return resource;
  }
  const attributes = optionalRecord(record.attributes);
  const dataRegion = optionalString(attributes?.data_region)?.trim();
  if (!attributes || !dataRegion) {
    return resource;
  }
  let sqlApiHost: string;
  try {
    sqlApiHost = buildBetterStackTelemetryHost(dataRegion);
  } catch {
    return resource;
  }
  return { ...record, attributes: { ...attributes, sql_api_host: sqlApiHost } };
}

export function buildBetterStackTelemetryAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export async function validateBetterStackTelemetryCredential(
  context: BetterStackTelemetryContext,
): Promise<CredentialValidationResult> {
  // apiToken and username/password are validated against different Better Stack subsystems (Telemetry API vs.
  // ClickHouse HTTP), and there is no static host to test against anymore: the SQL API host is derived per source
  // from its data_region. Discover the first available source (validates apiToken) and use its region to build the
  // host that proves username/password (validates the SQL API credential).
  const firstSource = await findFirstBetterStackTelemetrySource(context, "validate");
  if (firstSource) {
    await executeBetterStackTelemetryQuery(context, "SELECT 1", "validate", firstSource.host);
  }

  const teamName = firstSource ? optionalString(firstSource.attributes.team_name) : undefined;
  const teamId = firstSource ? optionalInteger(firstSource.attributes.team_id) : undefined;

  return {
    profile: {
      accountId: teamId !== undefined ? `better_stack_telemetry:team:${teamId}` : "better_stack_telemetry",
      displayName: teamName ? `Better Stack Telemetry (${teamName})` : "Better Stack Telemetry",
    },
    grantedScopes: [],
    metadata: {
      validatedAgainstDataRegion: firstSource?.attributes.data_region,
    },
  };
}

async function pingBetterStackTelemetry(context: BetterStackTelemetryContext): Promise<Record<string, unknown>> {
  const firstSource = await findFirstBetterStackTelemetrySource(context, "execute");
  if (!firstSource) {
    return {
      ok: true,
      message:
        "Better Stack Telemetry API token is reachable. No sources exist yet, so the ClickHouse SQL API host could not be derived or verified; create a source and retry, or call run_query with a sourceId once one exists.",
    };
  }

  await executeBetterStackTelemetryQuery(context, "SELECT 1", "execute", firstSource.host);
  return {
    ok: true,
    message: `Better Stack Telemetry Telemetry API token is reachable, and the SQL API connection to ${firstSource.host} (derived from source "${firstSource.name}", data_region ${firstSource.dataRegion}) succeeded.`,
  };
}

/**
 * Look up the first Better Stack Telemetry source visible to this credential, used to derive a ClickHouse host for
 * connection checks that otherwise have no fixed host to target. Returns undefined when the team has zero sources.
 */
async function findFirstBetterStackTelemetrySource(
  context: BetterStackTelemetryContext,
  phase: "validate" | "execute",
): Promise<(ResolvedBetterStackTelemetrySource & { attributes: Record<string, unknown> }) | undefined> {
  const payload = await requestBetterStackTelemetryApi(context, "/api/v2/sources", { per_page: 1 }, phase);
  const body = requireObjectPayload(payload, "better_stack_telemetry sources response");
  const sources = requireArrayPayload(body.data, "better_stack_telemetry sources response data");
  const first = sources[0];
  if (!first) {
    return undefined;
  }
  const resource = requireObjectPayload(first, "better_stack_telemetry source");
  const attributes = requireObjectPayload(resource.attributes, "better_stack_telemetry source attributes");
  const sourceId = optionalString(resource.id) ?? "";
  const resolved = resolveBetterStackTelemetrySourceFromAttributes(sourceId, attributes);
  return { ...resolved, attributes };
}

async function listBetterStackTelemetrySources(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const payload = await requestBetterStackTelemetryApi(
    context,
    "/api/v2/sources",
    {
      page: optionalPositiveInteger(input.page),
      per_page: clampPerPage(input.perPage),
    },
    "execute",
  );
  const body = requireObjectPayload(payload, "better_stack_telemetry sources response");
  return {
    sources: requireArrayPayload(body.data, "better_stack_telemetry sources response data").map(
      enrichBetterStackTelemetrySourceResource,
    ),
    pagination: readPagination(body.pagination),
  };
}

async function getBetterStackTelemetrySource(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const sourceId = requireField(input.sourceId, "sourceId");
  const payload = await requestBetterStackTelemetryApi(
    context,
    `/api/v2/sources/${encodeURIComponent(sourceId)}`,
    {},
    "execute",
  );
  // Unlike the list endpoint, get-a-single-source returns the resource unwrapped, without a top-level data envelope.
  const body = requireObjectPayload(payload, "better_stack_telemetry source response");
  return {
    source: enrichBetterStackTelemetrySourceResource(optionalRecord(body.data) ?? body),
  };
}

async function listBetterStackTelemetryMetrics(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const sourceId = requireField(input.sourceId, "sourceId");
  const payload = await requestBetterStackTelemetryApi(
    context,
    `/api/v2/sources/${encodeURIComponent(sourceId)}/metrics`,
    {
      page: optionalPositiveInteger(input.page),
      per_page: clampPerPage(input.perPage),
    },
    "execute",
  );
  const body = requireObjectPayload(payload, "better_stack_telemetry metrics response");
  return {
    metrics: requireArrayPayload(body.data, "better_stack_telemetry metrics response data"),
    pagination: readPagination(body.pagination),
  };
}

async function listBetterStackTelemetrySourceGroups(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const payload = await requestBetterStackTelemetryApi(
    context,
    "/api/v1/source-groups",
    {
      page: optionalPositiveInteger(input.page),
      per_page: clampPerPage(input.perPage),
    },
    "execute",
  );
  const body = requireObjectPayload(payload, "better_stack_telemetry source groups response");
  return {
    sourceGroups: requireArrayPayload(body.data, "better_stack_telemetry source groups response data"),
    pagination: readPagination(body.pagination),
  };
}

async function runBetterStackTelemetryQuery(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const sourceId = requireField(input.sourceId, "sourceId");
  const sql = requireSqlStatement(input.sql);
  const maxRows = clampRowLimit(input.maxRows, betterStackTelemetryDefaultRowLimit, betterStackTelemetryMaxRowLimit);
  const source = await resolveBetterStackTelemetrySource(context, sourceId);
  const rows = await executeBetterStackTelemetryQuery(context, sql, "execute", source.host);

  return {
    rows: rows.slice(0, maxRows),
    rowCount: Math.min(rows.length, maxRows),
    truncated: rows.length > maxRows,
    resolvedSource: describeResolvedSource(source),
  };
}

async function searchBetterStackTelemetryLogs(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const sourceId = requireField(input.sourceId, "sourceId");
  const searchText = optionalString(input.searchText)?.trim();
  const from = optionalString(input.from)?.trim();
  const to = optionalString(input.to)?.trim();
  const includeHistorical = input.includeHistorical !== false;
  const limit = clampRowLimit(input.limit, betterStackTelemetryDefaultLogLimit, betterStackTelemetryMaxLogLimit);
  const source = await resolveBetterStackTelemetrySource(context, sourceId);
  const logsTable = buildBetterStackTelemetryTableName(source, "_logs");
  const s3Table = buildBetterStackTelemetryTableName(source, "_s3");

  const recentSelect = `SELECT dt, raw FROM remote(${logsTable})`;
  const historicalSelect = `SELECT dt, raw FROM s3Cluster(primary, ${s3Table}) WHERE _row_type = 1`;
  const combinedSelect = includeHistorical ? `${recentSelect} UNION ALL ${historicalSelect}` : recentSelect;

  const conditions: string[] = [];
  if (from) {
    conditions.push(`dt >= parseDateTime64BestEffort(${sqlStringLiteral(from)})`);
  }
  if (to) {
    conditions.push(`dt <= parseDateTime64BestEffort(${sqlStringLiteral(to)})`);
  }
  if (searchText) {
    conditions.push(`raw LIKE ${sqlLikeLiteral(searchText)}`);
  }
  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  const sql = `SELECT dt, raw FROM (${combinedSelect})${whereClause} ORDER BY dt DESC LIMIT ${limit}`;
  const rows = await executeBetterStackTelemetryQuery(context, sql, "execute", source.host);

  const logs = rows.map((row) => {
    const dt = optionalString(row.dt) ?? "";
    const raw = optionalString(row.raw) ?? "";
    return {
      dt,
      raw,
      parsed: parseJsonOrNull(raw),
    };
  });

  return {
    logs,
    rowCount: logs.length,
    resolvedSource: describeResolvedSource(source),
  };
}

async function queryBetterStackTelemetryMetrics(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const sourceId = requireField(input.sourceId, "sourceId");
  const granularity = requireGranularity(input.granularity);
  const selectExpressions = requireExpressionList(input.selectExpressions, "selectExpressions");
  const groupByExpressions = optionalExpressionList(input.groupByExpressions);
  const metricName = optionalString(input.metricName)?.trim();
  const from = optionalString(input.from)?.trim();
  const to = optionalString(input.to)?.trim();
  const limit = clampRowLimit(input.limit, betterStackTelemetryDefaultRowLimit, betterStackTelemetryMaxRowLimit);
  const source = await resolveBetterStackTelemetrySource(context, sourceId);
  const metricsTable = buildBetterStackTelemetryTableName(
    source,
    granularity === "raw" ? "_metrics" : `_metrics_${granularity}`,
  );

  const table = `remote(${metricsTable})`;

  const conditions: string[] = [];
  if (metricName) {
    conditions.push(`name = ${sqlStringLiteral(metricName)}`);
  }
  if (from) {
    conditions.push(`dt >= parseDateTime64BestEffort(${sqlStringLiteral(from)})`);
  }
  if (to) {
    conditions.push(`dt <= parseDateTime64BestEffort(${sqlStringLiteral(to)})`);
  }
  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const groupByClause = groupByExpressions.length > 0 ? ` GROUP BY ${groupByExpressions.join(", ")}` : "";

  const sql = `SELECT ${selectExpressions.join(", ")} FROM ${table}${whereClause}${groupByClause} LIMIT ${limit}`;
  const rows = await executeBetterStackTelemetryQuery(context, sql, "execute", source.host);

  return {
    rows,
    rowCount: rows.length,
    table,
    resolvedSource: describeResolvedSource(source),
  };
}

/** Shape a resolved source into a compact, agent-visible summary of what host/table an action actually used. */
function describeResolvedSource(source: ResolvedBetterStackTelemetrySource): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    name: source.name,
    tableName: source.tableName,
    dataRegion: source.dataRegion,
    sqlApiHost: source.host,
  };
}

async function executeBetterStackTelemetryQuery(
  context: BetterStackTelemetryContext,
  sql: string,
  phase: "validate" | "execute",
  host: string,
): Promise<Record<string, unknown>[]> {
  const statement = `${sql.trim().replace(/;+\s*$/, "")} FORMAT JSONEachRow`;
  const url = new URL(`https://${host}/`);
  url.searchParams.set("output_format_pretty_row_numbers", "0");

  const timeout = createProviderTimeout(context.signal, betterStackTelemetryRequestTimeoutMs);
  let response: Response;
  try {
    response = await context.fetcher(url, {
      method: "POST",
      headers: {
        authorization: context.authorization,
        "content-type": "text/plain",
        "user-agent": providerUserAgent,
      },
      body: statement,
      signal: timeout.signal,
    });
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new ProviderRequestError(504, "better_stack_telemetry request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `better_stack_telemetry request failed: ${error.message}`
        : "better_stack_telemetry request failed: Unknown transport error",
    );
  } finally {
    timeout.cleanup();
  }

  const text = await readBoundedText(response);
  if (!response.ok) {
    throw createBetterStackTelemetryError(response.status, text, phase);
  }

  return parseJsonEachRow(text);
}

async function requestBetterStackTelemetryApi(
  context: BetterStackTelemetryContext,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  phase: "validate" | "execute",
): Promise<unknown> {
  const url = new URL(path, betterStackTelemetryApiBaseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const timeout = createProviderTimeout(context.signal, betterStackTelemetryRequestTimeoutMs);
  let response: Response;
  try {
    response = await context.fetcher(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${context.apiToken}`,
        accept: "application/json",
        "user-agent": providerUserAgent,
      },
      signal: timeout.signal,
    });
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new ProviderRequestError(504, "better_stack_telemetry Telemetry API request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error
        ? `better_stack_telemetry Telemetry API request failed: ${error.message}`
        : "better_stack_telemetry Telemetry API request failed: Unknown transport error",
    );
  } finally {
    timeout.cleanup();
  }

  const payload = await readBetterStackTelemetryApiPayload(response);
  if (!response.ok) {
    throw createBetterStackTelemetryApiError(response.status, payload, phase);
  }
  return payload;
}

async function readBetterStackTelemetryApiPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await readBoundedText(response);
  if (!text.trim()) {
    return null;
  }
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderRequestError(502, "better_stack_telemetry Telemetry API returned invalid JSON");
    }
  }
  return text;
}

function createBetterStackTelemetryApiError(
  status: number,
  payload: unknown,
  phase: "validate" | "execute",
): ProviderRequestError {
  const message =
    extractBetterStackTelemetryApiErrorMessage(payload) ?? `Telemetry API request failed with status ${status}`;

  if (status === 401 || status === 403) {
    return new ProviderRequestError(
      phase === "validate" ? 400 : status,
      phase === "validate" ? "Invalid Better Stack Telemetry API token." : message,
      payload,
    );
  }
  if (status === 404) {
    return new ProviderRequestError(400, message, payload);
  }
  if (status === 429) {
    return new ProviderRequestError(429, message, payload);
  }
  if (status === 400 || status === 422) {
    return new ProviderRequestError(400, message, payload);
  }
  return new ProviderRequestError(status >= 500 ? 502 : status, message, payload);
}

function extractBetterStackTelemetryApiErrorMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return optionalString(payload);
  }
  const record = optionalRecord(payload);
  if (!record) {
    return undefined;
  }
  const direct = optionalString(record.message) ?? optionalString(record.error);
  if (direct) {
    return direct;
  }
  return optionalString(record.errors);
}

function requireObjectPayload(value: unknown, label: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) {
    throw new ProviderRequestError(502, `${label} is not an object`);
  }
  return record;
}

function requireArrayPayload(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProviderRequestError(502, `${label} is not an array`);
  }
  return value;
}

function readPagination(value: unknown): Record<string, string | null> {
  const record = requireObjectPayload(value, "better_stack_telemetry pagination");
  return {
    first: readNullableString(record.first),
    last: readNullableString(record.last),
    prev: readNullableString(record.prev),
    next: readNullableString(record.next),
  };
}

function readNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = optionalString(value);
  if (text === undefined) {
    throw new ProviderRequestError(502, "better_stack_telemetry returned an invalid pagination link");
  }
  return text;
}

function requireField(value: unknown, fieldName: string): string {
  const text = optionalString(value)?.trim();
  if (!text) {
    throw new ProviderRequestError(400, `${fieldName} is required`);
  }
  return text;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = positiveInteger(value, "page", (message) => new ProviderRequestError(400, message));
  return parsed;
}

function clampPerPage(value: unknown): number | undefined {
  if (value === undefined) {
    return betterStackTelemetryDefaultPerPage;
  }
  const parsed = positiveInteger(value, "perPage", (message) => new ProviderRequestError(400, message));
  return Math.min(parsed, betterStackTelemetryMaxPerPage);
}

function requireSqlStatement(value: unknown): string {
  const sql = optionalString(value)?.trim();
  if (!sql) {
    throw new ProviderRequestError(400, "sql is required");
  }
  if (!sqlLeadingKeywordPattern.test(sql)) {
    throw new ProviderRequestError(400, "sql must start with SELECT or WITH");
  }
  if (sqlFormatKeywordPattern.test(sql)) {
    throw new ProviderRequestError(400, "sql must not include a FORMAT clause; JSONEachRow is applied automatically");
  }
  if (sql.replace(/;+\s*$/, "").includes(";")) {
    throw new ProviderRequestError(400, "sql must be a single statement");
  }
  return sql;
}

function requireGranularity(value: unknown): "raw" | "5m" | "1h" {
  const granularity = optionalString(value)?.trim();
  if (granularity === "raw" || granularity === "5m" || granularity === "1h") {
    return granularity;
  }
  throw new ProviderRequestError(400, "granularity must be one of raw, 5m, 1h");
}

function requireExpressionList(value: unknown, fieldName: string): string[] {
  const expressions = optionalExpressionList(value);
  if (expressions.length === 0) {
    throw new ProviderRequestError(400, `${fieldName} must contain at least one expression`);
  }
  return expressions;
}

function optionalExpressionList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => optionalString(item)?.trim())
    .filter((item): item is string => Boolean(item))
    .map((expression) => {
      if (expression.includes(";")) {
        throw new ProviderRequestError(400, "expressions must not contain semicolons");
      }
      return expression;
    });
}

function clampRowLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = positiveInteger(value, "limit", (message) => new ProviderRequestError(400, message));
  return Math.min(parsed, maximum);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function sqlLikeLiteral(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_").replaceAll("'", "\\'");
  return `'%${escaped}%'`;
}

function parseJsonOrNull(value: string): Record<string, unknown> | null {
  if (!value.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return optionalRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

function parseJsonEachRow(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ProviderRequestError(502, "better_stack_telemetry returned a malformed result row");
    }
    const record = optionalRecord(parsed);
    if (!record) {
      throw new ProviderRequestError(502, "better_stack_telemetry returned a non-object result row");
    }
    rows.push(record);
  }
  return rows;
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) {
    return response.text();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      total += value.byteLength;
      if (total > betterStackTelemetryMaxResponseBytes) {
        throw new ProviderRequestError(413, "better_stack_telemetry response exceeded the maximum allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function createBetterStackTelemetryError(
  status: number,
  responseText: string,
  phase: "validate" | "execute",
): ProviderRequestError {
  const message = responseText.trim() || `better_stack_telemetry request failed with status ${status}`;

  if (status === 401 || status === 403) {
    return new ProviderRequestError(
      phase === "validate" ? 400 : status,
      phase === "validate" ? "Invalid Better Stack Telemetry SQL API credentials." : message,
    );
  }
  if (status === 429) {
    return new ProviderRequestError(429, message);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderRequestError(400, message);
  }
  return new ProviderRequestError(status >= 500 ? 502 : status, message);
}
