import type {
  OpenAIUiEntrypoint,
  OpenAIUiResourceMetadata,
  OpenAIUiToolMetadata
} from "@openai/mcp-extensions/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiClient } from "./api.js";
import { WZRDMAIL_APP_HTML } from "./ui/app-html.generated.js";

const ENVELOPE_ICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#1a56db" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/></svg>'
  );

/** serverInfo for the McpServer — hosts fall back to this icon for entrypoints. */
export const WZRDMAIL_SERVER_INFO = {
  name: "wzrdmail",
  version: "0.0.1",
  title: "wzrdmail",
  icons: [{ src: ENVELOPE_ICON, mimeType: "image/svg+xml" }]
};

/** MCP App resources (MCP Apps `text/html;profile=mcp-app`). */
export const MAILBOX_RESOURCE_URI = "ui://wzrdmail/mailbox";
export const MESSAGE_RESOURCE_URI = "ui://wzrdmail/message";

/**
 * `_meta` marking a tool as an MCP App tool (`ui.resourceUri`) plus optional
 * OpenAI metadata (`openai/ui` entrypoints). Clients that do not speak these
 * extensions ignore `_meta`, so plain MCP behavior is unchanged.
 */
export const uiToolMeta = (
  resourceUri: string,
  openaiUi?: OpenAIUiToolMetadata
): Record<string, unknown> => ({
  ui: { resourceUri },
  ...(openaiUi === undefined ? {} : { "openai/ui": openaiUi })
});

const openaiUiMeta = (
  entrypoints: OpenAIUiEntrypoint[]
): OpenAIUiToolMetadata => ({ entrypoints });

const okJson = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
});

/* ------------------------------------------------------------------ */
/* Structured settings (openai/settings capability)                    */
/* ------------------------------------------------------------------ */

export interface WzrdmailSettings {
  /** Inbox the mailbox app selects first (empty = first inbox returned). */
  default_inbox: string;
  /** Page size for message and draft lists rendered by the app. */
  messages_per_page: number;
  /** Ask for confirmation inside the app before sending mail. */
  confirm_send: boolean;
}

const DEFAULT_SETTINGS: WzrdmailSettings = {
  default_inbox: "",
  messages_per_page: 25,
  confirm_send: true
};

export interface SettingsStore {
  read(): Promise<WzrdmailSettings>;
  update(set: Partial<WzrdmailSettings>): Promise<WzrdmailSettings>;
}

export const memorySettingsStore = (): SettingsStore => {
  let values = { ...DEFAULT_SETTINGS };
  return {
    read: async () => ({ ...values }),
    update: async (set) => {
      values = { ...values, ...set };
      return { ...values };
    }
  };
};

/** Durable Object storage-backed settings (persists per MCP session DO). */
export const durableObjectSettingsStore = (
  storage: DurableObjectStorage
): SettingsStore => {
  const KEY = "openai:settings";
  const read = async (): Promise<WzrdmailSettings> => ({
    ...DEFAULT_SETTINGS,
    ...((await storage.get<Partial<WzrdmailSettings>>(KEY)) ?? {})
  });
  return {
    read,
    update: async (set) => {
      const next = { ...(await read()), ...set };
      await storage.put(KEY, next);
      return next;
    }
  };
};

const SETTINGS_SCHEMA_JSON = {
  type: "object",
  properties: {
    default_inbox: {
      type: "string",
      title: "Default inbox",
      description: "Inbox address the mailbox app opens first."
    },
    messages_per_page: {
      type: "integer",
      title: "Messages per page",
      description: "Page size for message and draft lists in the app.",
      minimum: 1,
      maximum: 100
    },
    confirm_send: {
      type: "boolean",
      title: "Confirm before sending",
      description: "Ask for confirmation inside the app before sending mail."
    }
  }
} as const;

const settingsSetShape = {
  set: z
    .object({
      default_inbox: z.string().max(320),
      messages_per_page: z.number().int().min(1).max(100),
      confirm_send: z.boolean()
    })
    .partial()
    .strict()
    .refine((set) => Object.keys(set).length > 0, "Set at least one setting.")
};

const readToolName = "settings.read";
const updateToolName = "settings.update";

function registerSettingsTools(server: McpServer, store: SettingsStore): void {
  server.registerTool(
    readToolName,
    {
      description: "Read this plugin's settings schema, values, and layout.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        schema: z
          .object({
            type: z.literal("object"),
            properties: z.record(z.unknown()).optional(),
            required: z.array(z.string()).optional()
          })
          .passthrough(),
        values: z.record(z.unknown()),
        layout: z.array(z.record(z.unknown())).optional()
      }),
      annotations: { readOnlyHint: true }
    },
    async () => ({
      content: [],
      structuredContent: {
        schema: SETTINGS_SCHEMA_JSON,
        values: await store.read(),
        layout: [
          {
            kind: "group",
            title: "Mailbox",
            items: [
              { kind: "property", property: "default_inbox" },
              { kind: "property", property: "messages_per_page" },
              { kind: "property", property: "confirm_send" },
              { kind: "tool", title: "Open mailbox", tool: "open_mailbox" }
            ]
          }
        ]
      }
    })
  );

  server.registerTool(
    updateToolName,
    {
      description: "Update plugin settings (only changed keys are sent).",
      inputSchema: z.object(settingsSetShape).strict(),
      outputSchema: z.object({ values: z.record(z.unknown()) })
    },
    async ({ set }) => ({
      content: [],
      structuredContent: { values: await store.update(set) }
    })
  );

  const capability = { readTool: readToolName, updateTool: updateToolName };
  server.server.registerCapabilities({
    extensions: { "openai/settings": capability },
    experimental: { "openai/settings": capability }
  });
}

/* ------------------------------------------------------------------ */
/* UI resources + entrypoint tools                                     */
/* ------------------------------------------------------------------ */

const appHtml = (surface: "mailbox" | "message"): string =>
  WZRDMAIL_APP_HTML.replace("<html", `<html data-surface="${surface}"`);

function registerUiResources(server: McpServer): void {
  const readApp = (surface: "mailbox" | "message") => (uri: URL) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/html;profile=mcp-app",
        text: appHtml(surface),
        _meta: {
          "openai/ui": {
            availableDisplayModes: ["inline", "fullscreen"],
            preferredDisplayMode: surface === "mailbox" ? "fullscreen" : "inline"
          } satisfies OpenAIUiResourceMetadata,
          ui: {
            prefersBorder: true,
            // Self-contained app: no network access needed — every action
            // goes through server tool calls over the MCP Apps bridge.
            csp: { connectDomains: [], resourceDomains: [] }
          }
        }
      }
    ]
  });

  server.registerResource(
    "wzrdmail-mailbox-app",
    MAILBOX_RESOURCE_URI,
    {
      title: "wzrdmail Mailbox",
      description: "Fullscreen mailbox app: browse inboxes, read, and send mail.",
      mimeType: "text/html;profile=mcp-app"
    },
    readApp("mailbox")
  );

  server.registerResource(
    "wzrdmail-message-app",
    MESSAGE_RESOURCE_URI,
    {
      title: "wzrdmail Message",
      description: "Message view and compose surface for a single email.",
      mimeType: "text/html;profile=mcp-app"
    },
    readApp("message")
  );
}

function registerEntrypointTools(server: McpServer, api: ApiClient): void {
  server.registerTool(
    "open_mailbox",
    {
      title: "wzrdmail",
      description:
        "Open the wzrdmail mailbox app: browse inboxes, read messages, and send mail.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
      _meta: uiToolMeta(MAILBOX_RESOURCE_URI, openaiUiMeta([{ type: "global" }]))
    },
    async () =>
      okJson(await api.request({ method: "GET", path: "/v0/inboxes" }))
  );

  server.registerTool(
    "open_message",
    {
      title: "Message",
      description:
        "Open a message view with reply and compose in this conversation.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
      _meta: uiToolMeta(MESSAGE_RESOURCE_URI, openaiUiMeta([{ type: "thread" }]))
    },
    async () => okJson({ page: "compose" })
  );
}

/**
 * Registers every OpenAI MCP extension surface on the server: ui:// app
 * resources, entrypoint tools, and the openai/settings capability.
 */
export function registerExtensions(
  server: McpServer,
  api: ApiClient,
  settings: SettingsStore = memorySettingsStore()
): void {
  registerUiResources(server);
  registerEntrypointTools(server, api);
  registerSettingsTools(server, settings);
}
