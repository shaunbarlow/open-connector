import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "rtm";

const nonEmptyString = (description: string) => s.nonEmptyString(description);

const rtmUserSchema = s.object(
  "A Remember The Milk user identity.",
  {
    id: s.string("Remember The Milk user ID."),
    username: s.nullable(s.string("Remember The Milk username.")),
    fullName: s.nullable(s.string("Remember The Milk display name.")),
  },
  {
    optional: ["username", "fullName"],
    additionalProperties: true,
  },
);

const rtmTaskSchema = s.object(
  "A normalized Remember The Milk task. list_id/taskseries_id/task_id together identify the task for mutation actions.",
  {
    listId: s.string("Remember The Milk list ID that contains the task."),
    taskseriesId: s.string("Remember The Milk task series ID."),
    taskId: s.string("Remember The Milk task ID."),
    name: s.string("Task name."),
    tags: s.array("Tags applied to the task.", s.string("One tag name.")),
    due: s.nullable(s.string("Due date/time in ISO 8601 format, or null when unset.")),
    hasDueTime: s.boolean("Whether the due date includes a specific time."),
    added: s.nullable(s.string("Task creation timestamp in ISO 8601 format.")),
    completed: s.nullable(s.string("Completion timestamp in ISO 8601 format, or null when incomplete.")),
    deleted: s.nullable(s.string("Deletion timestamp in ISO 8601 format, or null when not deleted.")),
    priority: s.nullable(s.integer("Task priority: 1 (highest), 2, or 3, or null for no priority.")),
    postponed: s.integer("Number of times the task has been postponed."),
    estimate: s.nullable(s.string("Free-form time estimate string, or null when unset.")),
    url: s.nullable(s.string("Task-associated URL, or null when unset.")),
    source: s.nullable(s.string("Source that created the task series, e.g. api.")),
    created: s.nullable(s.string("Task series creation timestamp in ISO 8601 format.")),
    modified: s.nullable(s.string("Task series last-modified timestamp in ISO 8601 format.")),
  },
  {
    optional: [
      "due",
      "hasDueTime",
      "added",
      "completed",
      "deleted",
      "priority",
      "postponed",
      "estimate",
      "url",
      "source",
      "created",
      "modified",
    ],
    additionalProperties: true,
  },
);

const rtmListSchema = s.object(
  "A normalized Remember The Milk list.",
  {
    id: s.string("Remember The Milk list ID."),
    name: s.string("List name."),
    deleted: s.boolean("Whether the list is deleted."),
    locked: s.boolean("Whether the list is locked (e.g. Inbox, Sent)."),
    archived: s.boolean("Whether the list is archived."),
    position: s.integer("Sort position of the list."),
    smart: s.boolean("Whether the list is a Smart List."),
    filter: s.nullable(s.string("Smart List filter criteria, or null for a regular list.")),
  },
  {
    optional: ["deleted", "locked", "archived", "position", "smart", "filter"],
    additionalProperties: true,
  },
);

const taskIdentityInput = {
  listId: nonEmptyString("Remember The Milk list ID from a previous get_list call."),
  taskseriesId: nonEmptyString("Remember The Milk task series ID from a previous get_list call."),
  taskId: nonEmptyString("Remember The Milk task ID from a previous get_list call."),
} as const;

export const rtmActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "start_auth",
    description:
      "Start the Remember The Milk authorization flow. Returns a signed authUrl to open in a browser; after the user authorizes, call complete_auth with the returned frob.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input parameters for starting Remember The Milk authorization.",
      {
        perms: s.stringEnum(
          "Requested permission level. read allows viewing; write also allows adding/editing; delete also allows deleting. Defaults to delete.",
          ["read", "write", "delete"],
        ),
      },
      { optional: ["perms"] },
    ),
    outputSchema: s.object("The authorization URL and frob to complete the flow.", {
      authUrl: s.url("Signed Remember The Milk authorization URL. Open this in a browser and authorize the app."),
      frob: s.string("Frob to pass to complete_auth after the user authorizes."),
      perms: s.string("Permission level requested."),
    }),
  }),
  defineProviderAction(service, {
    name: "complete_auth",
    description:
      "Exchange a frob from start_auth for an auth token after the user has authorized the app. Automatically saves the token to this connection when the runtime supports it.",
    requiredScopes: [],
    inputSchema: s.object("Input parameters for completing Remember The Milk authorization.", {
      frob: nonEmptyString("Frob returned by start_auth."),
    }),
    outputSchema: s.object("The result of the token exchange.", {
      saved: s.boolean("Whether the auth token was saved to this connection automatically."),
      authToken: s.nullable(
        s.string(
          "The obtained auth token. Only returned when the runtime could not save it automatically; store it via the connection's authToken field.",
        ),
      ),
      perms: s.nullable(s.string("Permission level granted to this token.")),
      user: s.nullable(rtmUserSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "check_auth",
    description: "Verify the stored auth token is still valid and return the authorized user's identity.",
    requiredScopes: [],
    inputSchema: s.object("No input required.", {}),
    outputSchema: s.object("The authorized user and granted permission level.", {
      perms: s.nullable(s.string("Permission level granted to the stored auth token.")),
      user: rtmUserSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "get_list",
    description: "Retrieve tasks, optionally scoped to a list or filtered with Remember The Milk search syntax.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input parameters for retrieving Remember The Milk tasks.",
      {
        listId: nonEmptyString("Restrict results to this list ID. Omit to search across all lists."),
        filter: nonEmptyString(
          "Remember The Milk advanced search filter, e.g. status:incomplete AND dueBefore:tomorrow.",
        ),
        lastSync: s.dateTime("Only return tasks modified since this ISO 8601 timestamp."),
      },
      { optional: ["listId", "filter", "lastSync"] },
    ),
    outputSchema: s.object("Tasks returned by Remember The Milk.", {
      tasks: s.array("Matching tasks.", rtmTaskSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "add",
    description:
      'Add a task. When parse is true, name is processed with Remember The Milk Smart Add syntax (e.g. "Buy milk ^tomorrow !2 #errands") to set due date, priority, and tags from the text.',
    requiredScopes: [],
    inputSchema: s.object(
      "Input parameters for adding a Remember The Milk task.",
      {
        name: nonEmptyString("Task name, or a Smart Add string when parse is true."),
        listId: nonEmptyString("List ID to add the task to. Defaults to the Inbox."),
        parse: s.boolean("Whether to process name with Smart Add syntax. Defaults to false."),
        externalId: nonEmptyString("External ID to attach to the task for de-duplication."),
      },
      { optional: ["listId", "parse", "externalId"] },
    ),
    outputSchema: s.object("The created task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "complete",
    description: "Mark a task complete.",
    requiredScopes: [],
    inputSchema: s.object("Input parameters for completing a Remember The Milk task.", taskIdentityInput),
    outputSchema: s.object("The completed task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "uncomplete",
    description: "Mark a task incomplete.",
    requiredScopes: [],
    inputSchema: s.object("Input parameters for marking a Remember The Milk task incomplete.", taskIdentityInput),
    outputSchema: s.object("The updated task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "delete",
    description: "Mark a task deleted.",
    requiredScopes: [],
    inputSchema: s.object("Input parameters for deleting a Remember The Milk task.", taskIdentityInput),
    outputSchema: s.object("The deleted task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "set_name",
    description: "Rename a task.",
    requiredScopes: [],
    inputSchema: s.object("Input parameters for renaming a Remember The Milk task.", {
      ...taskIdentityInput,
      name: nonEmptyString("New task name."),
    }),
    outputSchema: s.object("The renamed task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "set_due_date",
    description:
      "Set or clear a task's due date. Omit due to clear the existing due date. When parse is true, due is parsed as natural-language text in the user's Remember The Milk timezone.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input parameters for setting a Remember The Milk task due date.",
      {
        ...taskIdentityInput,
        due: nonEmptyString("Due date/time in ISO 8601 format, or natural-language text when parse is true."),
        hasDueTime: s.boolean("Whether due includes a specific time rather than just a date."),
        parse: s.boolean("Whether to parse due as natural-language text. Defaults to false."),
      },
      { optional: ["due", "hasDueTime", "parse"] },
    ),
    outputSchema: s.object("The updated task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "set_priority",
    description: "Set a task's priority. Omit priority to clear it.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input parameters for setting a Remember The Milk task priority.",
      {
        ...taskIdentityInput,
        priority: s.integer("Priority: 1 (highest), 2, or 3. Omit to clear the priority.", {
          minimum: 1,
          maximum: 3,
        }),
      },
      { optional: ["priority"] },
    ),
    outputSchema: s.object("The updated task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "set_tags",
    description: "Replace all tags on a task. An empty array removes all tags.",
    requiredScopes: [],
    inputSchema: s.object("Input parameters for setting Remember The Milk task tags.", {
      ...taskIdentityInput,
      tags: s.array("Tags to apply to the task, replacing any existing tags.", s.string("One tag name.")),
    }),
    outputSchema: s.object("The updated task.", {
      task: rtmTaskSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "get_lists",
    description: "Retrieve all lists, including Smart Lists.",
    requiredScopes: [],
    inputSchema: s.object("No input required.", {}),
    outputSchema: s.object("Lists returned by Remember The Milk.", {
      lists: s.array("Lists.", rtmListSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "add_list",
    description: "Create a list. When filter is provided, a Smart List is created with that search criteria instead.",
    requiredScopes: [],
    inputSchema: s.object(
      "Input parameters for creating a Remember The Milk list.",
      {
        name: nonEmptyString("List name. Cannot be Inbox or Sent."),
        filter: nonEmptyString("Smart List filter criteria. When provided, creates a Smart List."),
      },
      { optional: ["filter"] },
    ),
    outputSchema: s.object("The created list.", {
      list: rtmListSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "get_tags",
    description: "Retrieve all tags in use across the account.",
    requiredScopes: [],
    inputSchema: s.object("No input required.", {}),
    outputSchema: s.object("Tags returned by Remember The Milk.", {
      tags: s.array("Tag names.", s.string("One tag name.")),
    }),
  }),
];
