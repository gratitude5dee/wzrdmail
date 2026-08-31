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
  ApiKey,
  AuthMe,
  CreateApiKeyInput,
  CreateDomainInput,
  CreateDraftInput,
  CreatePodInput,
  CreateWebhookInput,
  Domain,
  Draft,
  ForwardMessageInput,
  ListMessagesParams,
  ListParams,
  ListResponse,
  Pod,
  ReplyMessageInput,
  UpdateMessageInput,
  Usage,
  UsageMetric,
  Webhook,
  WebhookTestResult
} from "./types.js";
export type {
  Attachment,
  CreateInboxInput,
  Inbox,
  Message,
  SendMessageInput,
  Thread
} from "@wzrdmail/core";
