import type { CredentialValidationResult } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { ProviderFetch } from "../provider-runtime.ts";

import { optionalRecord, optionalString, positiveInteger } from "../../core/cast.ts";
import { assertPublicHttpUrl } from "../../core/request.ts";
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
  host: string;
  authorization: string;
  apiToken: string;
  fetcher: ProviderFetch;
  signal?: AbortSignal;
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

export function normalizeBetterStackTelemetryHost(value: unknown): string {
  const rawHost = optionalString(value)?.trim();
  if (!rawHost) {
    throw new ProviderRequestError(400, "host is required");
  }
  // The credential field is a bare hostname (as shown in the Better Stack dashboard); build a URL to validate it.
  const candidateUrl = rawHost.includes("://") ? rawHost : `https://${rawHost}`;
  const parsed = assertPublicHttpUrl(candidateUrl, {
    fieldName: "host",
    createError: (message) => new ProviderRequestError(400, message),
  });
  if (parsed.protocol !== "https:") {
    throw new ProviderRequestError(400, "host must resolve to an HTTPS endpoint");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ProviderRequestError(400, "host must be a bare hostname without path, query, or credentials");
  }
  return parsed.hostname;
}

export function buildBetterStackTelemetryAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export async function validateBetterStackTelemetryCredential(
  context: BetterStackTelemetryContext,
): Promise<CredentialValidationResult> {
  await executeBetterStackTelemetryQuery(context, "SELECT 1", "validate");
  await requestBetterStackTelemetryApi(context, "/api/v2/sources", { per_page: 1 }, "validate");

  return {
    profile: {
      accountId: `better_stack_telemetry:${context.host}`,
      displayName: `Better Stack Telemetry (${context.host})`,
    },
    grantedScopes: [],
    metadata: {
      host: context.host,
    },
  };
}

async function pingBetterStackTelemetry(context: BetterStackTelemetryContext): Promise<Record<string, unknown>> {
  await executeBetterStackTelemetryQuery(context, "SELECT 1", "execute");
  await requestBetterStackTelemetryApi(context, "/api/v2/sources", { per_page: 1 }, "execute");
  return {
    ok: true,
    message: `Better Stack Telemetry SQL API connection and Telemetry API token for ${context.host} are both reachable.`,
  };
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
    sources: requireArrayPayload(body.data, "better_stack_telemetry sources response data"),
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
    source: optionalRecord(body.data) ?? body,
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
  const sql = requireSqlStatement(input.sql);
  const maxRows = clampRowLimit(input.maxRows, betterStackTelemetryDefaultRowLimit, betterStackTelemetryMaxRowLimit);
  const rows = await executeBetterStackTelemetryQuery(context, sql, "execute");

  return {
    rows: rows.slice(0, maxRows),
    rowCount: Math.min(rows.length, maxRows),
    truncated: rows.length > maxRows,
  };
}

async function searchBetterStackTelemetryLogs(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const sourceTable = requireSourceTable(input.sourceTable);
  const searchText = optionalString(input.searchText)?.trim();
  const from = optionalString(input.from)?.trim();
  const to = optionalString(input.to)?.trim();
  const includeHistorical = input.includeHistorical !== false;
  const limit = clampRowLimit(input.limit, betterStackTelemetryDefaultLogLimit, betterStackTelemetryMaxLogLimit);

  const recentSelect = `SELECT dt, raw FROM remote(${sourceTable}_logs)`;
  const historicalSelect = `SELECT dt, raw FROM s3Cluster(primary, ${sourceTable}_s3) WHERE _row_type = 1`;
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
  const rows = await executeBetterStackTelemetryQuery(context, sql, "execute");

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
  };
}

async function queryBetterStackTelemetryMetrics(
  input: Record<string, unknown>,
  context: BetterStackTelemetryContext,
): Promise<Record<string, unknown>> {
  const sourceTable = requireSourceTable(input.sourceTable);
  const granularity = requireGranularity(input.granularity);
  const selectExpressions = requireExpressionList(input.selectExpressions, "selectExpressions");
  const groupByExpressions = optionalExpressionList(input.groupByExpressions);
  const metricName = optionalString(input.metricName)?.trim();
  const from = optionalString(input.from)?.trim();
  const to = optionalString(input.to)?.trim();
  const limit = clampRowLimit(input.limit, betterStackTelemetryDefaultRowLimit, betterStackTelemetryMaxRowLimit);

  const table = `remote(${sourceTable}_metrics${granularity === "raw" ? "" : `_${granularity}`})`;

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
  const rows = await executeBetterStackTelemetryQuery(context, sql, "execute");

  return {
    rows,
    rowCount: rows.length,
    table,
  };
}

async function executeBetterStackTelemetryQuery(
  context: BetterStackTelemetryContext,
  sql: string,
  phase: "validate" | "execute",
): Promise<Record<string, unknown>[]> {
  const statement = `${sql.trim().replace(/;+\s*$/, "")} FORMAT JSONEachRow`;
  const url = new URL(`https://${context.host}/`);
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

function requireSourceTable(value: unknown): string {
  const sourceTable = optionalString(value)?.trim();
  if (!sourceTable || !sourceTablePattern.test(sourceTable)) {
    throw new ProviderRequestError(400, "sourceTable must contain only letters, digits, and underscores");
  }
  return sourceTable;
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
