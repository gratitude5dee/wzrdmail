export {
  WzrdMailClient,
  type WithClientIdAlias,
  type WzrdMailClientOptions
} from "./client.js";
export { WzrdmailError } from "./error.js";
export { DEFAULT_BASE_URL, type FetchLike } from "./http.js";
export type {
  AgentSignUpResponse,
  AgentVerifyResponse,
  CreateDomainInput,
  CreateWebhookInput,
  Domain,
  ListMessagesParams,
  ListParams,
  ListResponse,
  Webhook
} from "./types.js";
export type {
  Attachment,
  CreateInboxInput,
  Inbox,
  Message,
  SendMessageInput,
  Thread
} from "@wzrdmail/core";
