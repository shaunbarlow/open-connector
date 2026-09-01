import type { CredentialValidationResult, ExecutionContext } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { createHash } from "node:crypto";
import { compactObject, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

export const rtmApiBaseUrl = "https://api.rememberthemilk.com/services/rest/";
export const rtmAuthBaseUrl = "https://www.rememberthemilk.com/services/auth/";

export interface RtmActionContext {
  apiKey: string;
  sharedSecret: string;
  authToken?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  updateCredential?: ExecutionContext["updateCredential"];
}

type RtmActionHandler = (input: Record<string, unknown>, context: RtmActionContext) => Promise<unknown>;

interface RtmCredentialInput {
  apiKey: string;
  sharedSecret: string;
  authToken?: string;
}

/**
 * Sign a Remember The Milk request per the documented algorithm: sort
 * parameters by key, concatenate key+value pairs, prepend the shared secret,
 * and MD5 the result. See
 * https://www.rememberthemilk.com/services/api/authentication.rtm.
 */
export function signRtmParams(sharedSecret: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  return createHash("md5").update(`${sharedSecret}${sorted}`, "utf8").digest("hex");
}

function buildSignedSearchParams(sharedSecret: string, params: Record<string, string>): URLSearchParams {
  const signature = signRtmParams(sharedSecret, params);
  const search = new URLSearchParams(params);
  search.set("api_sig", signature);
  return search;
}

/** Build the signed browser authorization URL for the frob-based desktop auth flow. */
export function buildRtmAuthUrl(
  credential: Pick<RtmCredentialInput, "apiKey" | "sharedSecret">,
  input: { perms: string; frob: string },
): string {
  const params: Record<string, string> = {
    api_key: credential.apiKey,
    perms: input.perms,
    frob: input.frob,
  };
  const url = new URL(rtmAuthBaseUrl);
  url.search = buildSignedSearchParams(credential.sharedSecret, params).toString();
  return url.toString();
}

interface RtmRequestInput {
  credential: Pick<RtmCredentialInput, "apiKey" | "sharedSecret">;
  authToken?: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  method: string;
  params?: Record<string, string | undefined>;
}

/** Call one Remember The Milk REST method and return its parsed response body. */
async function rtmRequest(input: RtmRequestInput): Promise<Record<string, unknown>> {
  const params: Record<string, string> = compactObject({
    method: input.method,
    api_key: input.credential.apiKey,
    auth_token: input.authToken,
    format: "json",
    ...input.params,
  }) as Record<string, string>;

  const search = buildSignedSearchParams(input.credential.sharedSecret, params);
  const response = await input.fetcher(`${rtmApiBaseUrl}?${search.toString()}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": providerUserAgent,
    },
    signal: input.signal,
  });

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderRequestError(502, `Remember The Milk ${input.method} returned invalid JSON: ${detail}`);
  }

  const rsp = optionalRecord(optionalRecord(payload)?.rsp);
  if (!rsp) {
    throw new ProviderRequestError(502, `Remember The Milk ${input.method} returned an unrecognized response`);
  }
  if (rsp.stat === "ok") {
    return rsp;
  }

  const err = optionalRecord(rsp.err);
  const code = optionalString(err?.code);
  const message = optionalString(err?.msg) ?? `Remember The Milk ${input.method} failed`;
  if (code === "98") {
    throw new ProviderRequestError(401, message);
  }
  if (code === "96" || code === "97") {
    throw new ProviderRequestError(401, `Remember The Milk request signature error: ${message}`);
  }
  throw new ProviderRequestError(400, message, { code });
}

async function createTimeline(context: RtmActionContext): Promise<string> {
  const authToken = requireAuthToken(context);
  const rsp = await rtmRequest({
    credential: context,
    authToken,
    fetcher: context.fetcher,
    signal: context.signal,
    method: "rtm.timelines.create",
  });
  return requiredString(rsp.timeline, "timeline", (message) => new ProviderRequestError(502, message));
}

function requireAuthToken(context: RtmActionContext): string {
  if (!context.authToken) {
    throw new ProviderRequestError(
      401,
      "Configure a Remember The Milk auth token first: run start_auth, authorize, then complete_auth.",
    );
  }
  return context.authToken;
}

/** Normalize a value that RTM's JSON serializer emits as a bare object when there is exactly one item. */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readPriority(value: unknown): number | undefined {
  const text = optionalString(value);
  if (!text || text === "N") {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function normalizeTask(listId: string, taskseries: Record<string, unknown>, task: Record<string, unknown>) {
  const tagsContainer = optionalRecord(taskseries.tags);
  const tags = tagsContainer ? toArray(tagsContainer.tag).map((tag) => String(tag)) : [];

  return compactObject({
    listId,
    taskseriesId: requiredString(taskseries.id, "taskseries.id", (message) => new ProviderRequestError(502, message)),
    taskId: requiredString(task.id, "task.id", (message) => new ProviderRequestError(502, message)),
    name: optionalString(taskseries.name) ?? "",
    tags,
    due: optionalString(task.due) || null,
    hasDueTime: task.has_due_time === "1",
    added: optionalString(task.added) || null,
    completed: optionalString(task.completed) || null,
    deleted: optionalString(task.deleted) || null,
    priority: readPriority(task.priority) ?? null,
    postponed: Number(optionalString(task.postponed) ?? "0") || 0,
    estimate: optionalString(task.estimate) || null,
    url: optionalString(taskseries.url) || null,
    source: optionalString(taskseries.source) || null,
    created: optionalString(taskseries.created) || null,
    modified: optionalString(taskseries.modified) || null,
  });
}

function normalizeTasksResponse(rsp: Record<string, unknown>) {
  const tasksContainer = optionalRecord(rsp.tasks);
  const lists = tasksContainer ? toArray(tasksContainer.list as unknown) : [];
  return lists.flatMap((listValue) => {
    const list = optionalRecord(listValue);
    if (!list) {
      return [];
    }
    const listId = requiredString(list.id, "list.id", (message) => new ProviderRequestError(502, message));
    return toArray(list.taskseries as unknown).flatMap((taskseriesValue) => {
      const taskseries = optionalRecord(taskseriesValue);
      if (!taskseries) {
        return [];
      }
      return toArray(taskseries.task as unknown).flatMap((taskValue) => {
        const task = optionalRecord(taskValue);
        return task ? [normalizeTask(listId, taskseries, task)] : [];
      });
    });
  });
}

function normalizeSingleTaskMutation(rsp: Record<string, unknown>, method: string) {
  const list = optionalRecord(rsp.list);
  if (!list) {
    throw new ProviderRequestError(502, `Remember The Milk ${method} response is missing list`);
  }
  const listId = requiredString(list.id, "list.id", (message) => new ProviderRequestError(502, message));
  const taskseries = optionalRecord(toArray(list.taskseries as unknown)[0]);
  if (!taskseries) {
    throw new ProviderRequestError(502, `Remember The Milk ${method} response is missing taskseries`);
  }
  const task = optionalRecord(toArray(taskseries.task as unknown)[0]);
  if (!task) {
    throw new ProviderRequestError(502, `Remember The Milk ${method} response is missing task`);
  }
  return normalizeTask(listId, taskseries, task);
}

function normalizeList(list: Record<string, unknown>) {
  return compactObject({
    id: requiredString(list.id, "list.id", (message) => new ProviderRequestError(502, message)),
    name: optionalString(list.name) ?? "",
    deleted: list.deleted === "1",
    locked: list.locked === "1",
    archived: list.archived === "1",
    position: Number(optionalString(list.position) ?? "0") || 0,
    smart: list.smart === "1",
    filter: optionalString(list.filter) || null,
  });
}

function readUser(record: Record<string, unknown> | undefined) {
  if (!record) {
    return null;
  }
  return compactObject({
    id: requiredString(record.id, "user.id", (message) => new ProviderRequestError(502, message)),
    username: optionalString(record.username) || null,
    fullName: optionalString(record.fullname) || null,
  });
}

async function performTaskMutation(
  context: RtmActionContext,
  method: string,
  input: Record<string, unknown>,
  extraParams: Record<string, string | undefined> = {},
): Promise<unknown> {
  const authToken = requireAuthToken(context);
  const timeline = await createTimeline(context);
  const rsp = await rtmRequest({
    credential: context,
    authToken,
    fetcher: context.fetcher,
    signal: context.signal,
    method,
    params: {
      timeline,
      list_id: requiredString(input.listId, "listId", (message) => new ProviderRequestError(400, message)),
      taskseries_id: requiredString(
        input.taskseriesId,
        "taskseriesId",
        (message) => new ProviderRequestError(400, message),
      ),
      task_id: requiredString(input.taskId, "taskId", (message) => new ProviderRequestError(400, message)),
      ...extraParams,
    },
  });
  return { task: normalizeSingleTaskMutation(rsp, method) };
}

export const rtmActionHandlers: ProviderActionHandlers<"rtm", RtmActionHandler> = {
  async start_auth(input, context) {
    const perms = optionalString(input.perms) ?? "delete";
    const rsp = await rtmRequest({
      credential: context,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.auth.getFrob",
    });
    const frob = requiredString(rsp.frob, "frob", (message) => new ProviderRequestError(502, message));
    return {
      authUrl: buildRtmAuthUrl(context, { perms, frob }),
      frob,
      perms,
    };
  },
  async complete_auth(input, context) {
    const frob = requiredString(input.frob, "frob", (message) => new ProviderRequestError(400, message));
    const rsp = await rtmRequest({
      credential: context,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.auth.getToken",
      params: { frob },
    });
    const auth = optionalRecord(rsp.auth);
    const authToken = requiredString(auth?.token, "auth.token", (message) => new ProviderRequestError(502, message));
    const perms = optionalString(auth?.token ? auth?.perms : undefined) ?? null;
    const user = readUser(optionalRecord(auth?.user));

    if (context.updateCredential) {
      await context.updateCredential({ authToken });
      return { saved: true, authToken: null, perms, user };
    }
    return { saved: false, authToken, perms, user };
  },
  async check_auth(_input, context) {
    const authToken = requireAuthToken(context);
    const rsp = await rtmRequest({
      credential: context,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.auth.checkToken",
      params: { auth_token: authToken },
    });
    const auth = optionalRecord(rsp.auth);
    return {
      perms: optionalString(auth?.perms) ?? null,
      user: readUser(optionalRecord(auth?.user)) ?? {
        id: "",
        username: null,
        fullName: null,
      },
    };
  },
  async get_list(input, context) {
    const authToken = requireAuthToken(context);
    const rsp = await rtmRequest({
      credential: context,
      authToken,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.tasks.getList",
      params: {
        list_id: optionalString(input.listId),
        filter: optionalString(input.filter),
        last_sync: optionalString(input.lastSync),
      },
    });
    return { tasks: normalizeTasksResponse(rsp) };
  },
  async add(input, context) {
    const authToken = requireAuthToken(context);
    const timeline = await createTimeline(context);
    const rsp = await rtmRequest({
      credential: context,
      authToken,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.tasks.add",
      params: {
        timeline,
        name: requiredString(input.name, "name", (message) => new ProviderRequestError(400, message)),
        list_id: optionalString(input.listId),
        parse: input.parse === true ? "1" : undefined,
        external_id: optionalString(input.externalId),
      },
    });
    return { task: normalizeSingleTaskMutation(rsp, "rtm.tasks.add") };
  },
  async complete(input, context) {
    return performTaskMutation(context, "rtm.tasks.complete", input);
  },
  async uncomplete(input, context) {
    return performTaskMutation(context, "rtm.tasks.uncomplete", input);
  },
  async delete(input, context) {
    return performTaskMutation(context, "rtm.tasks.delete", input);
  },
  async set_name(input, context) {
    return performTaskMutation(context, "rtm.tasks.setName", input, {
      name: requiredString(input.name, "name", (message) => new ProviderRequestError(400, message)),
    });
  },
  async set_due_date(input, context) {
    return performTaskMutation(context, "rtm.tasks.setDueDate", input, {
      due: optionalString(input.due) ?? "",
      has_due_time: input.hasDueTime === true ? "1" : input.hasDueTime === false ? "0" : undefined,
      parse: input.parse === true ? "1" : undefined,
    });
  },
  async set_priority(input, context) {
    return performTaskMutation(context, "rtm.tasks.setPriority", input, {
      priority: optionalString(input.priority !== undefined ? String(input.priority) : undefined),
    });
  },
  async set_tags(input, context) {
    const tags = Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : [];
    return performTaskMutation(context, "rtm.tasks.setTags", input, {
      tags: tags.join(","),
    });
  },
  async get_lists(_input, context) {
    const authToken = requireAuthToken(context);
    const rsp = await rtmRequest({
      credential: context,
      authToken,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.lists.getList",
    });
    const container = optionalRecord(rsp.lists);
    const lists = container ? toArray(container.list as unknown) : [];
    return {
      lists: lists.flatMap((value) => {
        const list = optionalRecord(value);
        return list ? [normalizeList(list)] : [];
      }),
    };
  },
  async add_list(input, context) {
    const authToken = requireAuthToken(context);
    const timeline = await createTimeline(context);
    const rsp = await rtmRequest({
      credential: context,
      authToken,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.lists.add",
      params: {
        timeline,
        name: requiredString(input.name, "name", (message) => new ProviderRequestError(400, message)),
        filter: optionalString(input.filter),
      },
    });
    const list = optionalRecord(rsp.list);
    if (!list) {
      throw new ProviderRequestError(502, "Remember The Milk rtm.lists.add response is missing list");
    }
    return { list: normalizeList(list) };
  },
  async get_tags(_input, context) {
    const authToken = requireAuthToken(context);
    const rsp = await rtmRequest({
      credential: context,
      authToken,
      fetcher: context.fetcher,
      signal: context.signal,
      method: "rtm.tags.getList",
    });
    const container = optionalRecord(rsp.tags);
    const tags = container ? toArray(container.tag as unknown) : [];
    return {
      tags: tags.flatMap((value) => {
        const tag = optionalRecord(value);
        const name = optionalString(tag?.name);
        return name ? [name] : [];
      }),
    };
  },
};

export interface RtmCustomCredentialValidationInput {
  values: Record<string, string>;
}

export async function validateRtmCredential(
  input: RtmCustomCredentialValidationInput,
  options: { fetcher: typeof fetch; signal?: AbortSignal },
): Promise<CredentialValidationResult> {
  const credential = resolveRtmCredential(input.values);
  if (!credential.authToken) {
    return {
      profile: {
        accountId: `rtm:${credential.apiKey}`,
        displayName: "Remember The Milk (pending authorization)",
      },
      grantedScopes: [],
    };
  }

  const rsp = await rtmRequest({
    credential,
    authToken: credential.authToken,
    fetcher: options.fetcher,
    signal: options.signal,
    method: "rtm.auth.checkToken",
    params: { auth_token: credential.authToken },
  });
  const auth = optionalRecord(rsp.auth);
  const user = readUser(optionalRecord(auth?.user));
  const perms = optionalString(auth?.perms);

  return {
    profile: {
      accountId: user?.id ? String(user.id) : `rtm:${credential.apiKey}`,
      displayName: (user?.fullName as string | null) ?? (user?.username as string | null) ?? "Remember The Milk",
    },
    grantedScopes: perms ? [perms] : [],
  };
}

function resolveRtmCredential(values: Record<string, string | undefined>): RtmCredentialInput {
  return {
    apiKey: requiredString(values.apiKey, "apiKey", (message) => new ProviderRequestError(400, message)),
    sharedSecret: requiredString(
      values.sharedSecret,
      "sharedSecret",
      (message) => new ProviderRequestError(400, message),
    ),
    authToken: optionalString(values.authToken),
  };
}
