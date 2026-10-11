import type {
  AgentSignUpInput,
  AgentVerifyInput,
  Attachment,
  CreateInboxInput,
  Inbox,
  Message,
  MessageEvent,
  SendMessageInput,
  ShareLink,
  Suppression,
  Template,
  Thread
} from "@wzrdmail/core";
import { z } from "zod";
import { HttpClient, encodePath, type HttpClientOptions } from "./http.js";
import type {
  AgentSignUpResponse,
  AgentVerifyResponse,
  ApiKey,
  AuthMe,
  BatchSendOptions,
  BatchSendResult,
  BatchSuppressionInput,
  CreateApiKeyInput,
  CreateDomainInput,
  CreateDraftInput,
  CreatePodInput,
  CreateSuppressionInput,
  CreateTemplateInput,
  CreateWebhookInput,
  Domain,
  Draft,
  ForwardMessageInput,
  ListMessagesParams,
  ListParams,
  ListResponse,
  ListSuppressionsParams,
  Metrics,
  MetricsParams,
  PlanUsage,
  Pod,
  ReplyMessageInput,
  RotateWebhookSecretResult,
  ShareMessageOptions,
  SuppressionBatchResult,
  UpdateApiKeyInput,
  UpdateApiKeyResult,
  UpdateDomainInput,
  UpdateInboxInput,
  UpdateMessageInput,
  UpdateTemplateInput,
  Usage,
  Webhook,
  WebhookTestResult
} from "./types.js";

export type WzrdMailClientOptions = HttpClientOptions;

/** AgentMail's SDK accepts camelCase `clientId` (goal.md §11); the wire field is `client_id`. */
export type WithClientIdAlias<T> = T & { clientId?: string };

function mapClientId<T extends { client_id?: string }>(
  input: WithClientIdAlias<T>
): T {
  const { clientId, ...rest } = input;
  if (clientId !== undefined && rest.client_id === undefined) {
    return { ...rest, client_id: clientId } as T;
  }
  return rest as T;
}

type SignUpInput = z.infer<typeof AgentSignUpInput>;
type VerifyInput = z.infer<typeof AgentVerifyInput>;

class MessagesResource {
  constructor(private readonly http: HttpClient) {}

  send(
    inboxId: string,
    input: WithClientIdAlias<SendMessageInput>
  ): Promise<Message> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/send`,
      body: mapClientId(input)
    });
  }

  list(
    inboxId: string,
    params: ListMessagesParams = {}
  ): Promise<ListResponse<"messages", Message>> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages`,
      query: { ...params }
    });
  }

  get(inboxId: string, messageId: string): Promise<Message> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}`
    });
  }

  reply(
    inboxId: string,
    messageId: string,
    input: WithClientIdAlias<ReplyMessageInput>
  ): Promise<Message> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}/reply`,
      body: mapClientId(input)
    });
  }

  replyAll(
    inboxId: string,
    messageId: string,
    input: WithClientIdAlias<ReplyMessageInput>
  ): Promise<Message> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}/reply-all`,
      body: mapClientId(input)
    });
  }

  forward(
    inboxId: string,
    messageId: string,
    input: WithClientIdAlias<ForwardMessageInput>
  ): Promise<Message> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}/forward`,
      body: mapClientId(input)
    });
  }

  update(
    inboxId: string,
    messageId: string,
    input: UpdateMessageInput
  ): Promise<Message> {
    return this.http.request({
      method: "PATCH",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}`,
      body: input
    });
  }

  /** Up to 100 sends in one call; per-item `{index, ...Message}|{index, error}` results. */
  batchSend(
    inboxId: string,
    messages: WithClientIdAlias<SendMessageInput>[],
    options: BatchSendOptions = {}
  ): Promise<BatchSendResult> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/batch-send`,
      body: { messages: messages.map((m) => mapClientId(m)) },
      headers:
        options.idempotencyKey === undefined
          ? undefined
          : { "Idempotency-Key": options.idempotencyKey }
    });
  }

  /** Cancel a scheduled send without trashing it (state → `cancelled`). */
  cancel(inboxId: string, messageId: string): Promise<Message> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}/cancel`
    });
  }

  /** PATCH send_at: reschedule a scheduled send or re-arm a cancelled one. */
  reschedule(
    inboxId: string,
    messageId: string,
    sendAt: string
  ): Promise<Message> {
    return this.update(inboxId, messageId, { send_at: sendAt });
  }

  /** Attachment metadata for a message (inbound and outbound). */
  async listAttachments(
    inboxId: string,
    messageId: string
  ): Promise<Attachment[]> {
    const res = await this.http.request<{ attachments: Attachment[] }>({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}/attachments`
    });
    return res.attachments;
  }

  /** Per-message event timeline (scheduled→sent→delivered/bounced/…). */
  async events(inboxId: string, messageId: string): Promise<MessageEvent[]> {
    const res = await this.http.request<{ events: MessageEvent[] }>({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}/events`
    });
    return res.events;
  }

  /** Mint a public, expiring share link rendering the message's sanitized HTML. */
  share(
    inboxId: string,
    messageId: string,
    options: ShareMessageOptions = {}
  ): Promise<ShareLink> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/${encodePath(messageId)}/share`,
      body: { expires_in: options.expires_in }
    });
  }
}

class DraftsResource {
  constructor(private readonly http: HttpClient) {}

  list(
    inboxId: string,
    params: ListParams = {}
  ): Promise<ListResponse<"drafts", Draft>> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/drafts`,
      query: { ...params }
    });
  }

  create(
    inboxId: string,
    input: WithClientIdAlias<CreateDraftInput>
  ): Promise<Draft> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/drafts`,
      body: mapClientId(input)
    });
  }

  get(inboxId: string, draftId: string): Promise<Draft> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/drafts/${encodePath(draftId)}`
    });
  }

  update(
    inboxId: string,
    draftId: string,
    input: CreateDraftInput
  ): Promise<Draft> {
    return this.http.request({
      method: "PATCH",
      path: `/v0/inboxes/${encodePath(inboxId)}/drafts/${encodePath(draftId)}`,
      body: input
    });
  }

  delete(inboxId: string, draftId: string): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/v0/inboxes/${encodePath(inboxId)}/drafts/${encodePath(draftId)}`
    });
  }

  send(inboxId: string, draftId: string): Promise<Message> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/drafts/${encodePath(draftId)}/send`
    });
  }
}

class InboxThreadsResource {
  constructor(private readonly http: HttpClient) {}

  list(
    inboxId: string,
    params: ListParams = {}
  ): Promise<ListResponse<"threads", Thread>> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/threads`,
      query: { ...params }
    });
  }

  get(inboxId: string, threadId: string): Promise<Thread> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/threads/${encodePath(threadId)}`
    });
  }

  search(
    inboxId: string,
    params: ListParams & { query: string }
  ): Promise<ListResponse<"threads", Thread>> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}/threads/search`,
      query: { ...params }
    });
  }
}

class InboxesResource {
  readonly messages: MessagesResource;
  readonly threads: InboxThreadsResource;
  readonly drafts: DraftsResource;

  constructor(private readonly http: HttpClient) {
    this.messages = new MessagesResource(http);
    this.threads = new InboxThreadsResource(http);
    this.drafts = new DraftsResource(http);
  }

  create(input: WithClientIdAlias<CreateInboxInput> = {}): Promise<Inbox> {
    return this.http.request({
      method: "POST",
      path: "/v0/inboxes",
      body: mapClientId(input)
    });
  }

  list(params: ListParams = {}): Promise<ListResponse<"inboxes", Inbox>> {
    return this.http.request({
      method: "GET",
      path: "/v0/inboxes",
      query: { ...params }
    });
  }

  get(inboxId: string): Promise<Inbox> {
    return this.http.request({
      method: "GET",
      path: `/v0/inboxes/${encodePath(inboxId)}`
    });
  }

  delete(inboxId: string): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/v0/inboxes/${encodePath(inboxId)}`
    });
  }

  update(inboxId: string, input: UpdateInboxInput): Promise<Inbox> {
    return this.http.request({
      method: "PATCH",
      path: `/v0/inboxes/${encodePath(inboxId)}`,
      body: input
    });
  }
}

class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  create(input: WithClientIdAlias<CreateWebhookInput>): Promise<Webhook> {
    return this.http.request({
      method: "POST",
      path: "/v0/webhooks",
      body: mapClientId(input)
    });
  }

  list(params: ListParams = {}): Promise<ListResponse<"webhooks", Webhook>> {
    return this.http.request({
      method: "GET",
      path: "/v0/webhooks",
      query: { ...params }
    });
  }

  delete(webhookId: string): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/v0/webhooks/${encodePath(webhookId)}`
    });
  }

  test(webhookId: string): Promise<WebhookTestResult> {
    return this.http.request({
      method: "POST",
      path: `/v0/webhooks/${encodePath(webhookId)}/test`
    });
  }

  /** Rotate the signing secret; the new plaintext is returned exactly once. */
  rotateSecret(webhookId: string): Promise<RotateWebhookSecretResult> {
    return this.http.request({
      method: "POST",
      path: `/v0/webhooks/${encodePath(webhookId)}/rotate-secret`
    });
  }

  /** Event payloads matching this webhook's org/pod/inbox/event_type filter. */
  events(
    webhookId: string,
    params: ListParams = {}
  ): Promise<ListResponse<"events", MessageEvent>> {
    return this.http.request({
      method: "GET",
      path: `/v0/webhooks/${encodePath(webhookId)}/events`,
      query: { ...params }
    });
  }
}

class AgentResource {
  constructor(private readonly http: HttpClient) {}

  signUp(input: SignUpInput): Promise<AgentSignUpResponse> {
    return this.http.request({
      method: "POST",
      path: "/v0/agent/sign-up",
      body: input,
      auth: false
    });
  }

  verify(input: VerifyInput): Promise<AgentVerifyResponse> {
    return this.http.request({
      method: "POST",
      path: "/v0/agent/verify",
      body: input
    });
  }
}

class DomainsResource {
  constructor(private readonly http: HttpClient) {}

  create(input: WithClientIdAlias<CreateDomainInput>): Promise<Domain> {
    return this.http.request({
      method: "POST",
      path: "/v0/domains",
      body: mapClientId(input)
    });
  }

  list(params: ListParams = {}): Promise<ListResponse<"domains", Domain>> {
    return this.http.request({
      method: "GET",
      path: "/v0/domains",
      query: { ...params }
    });
  }

  verify(domainId: string): Promise<Domain> {
    return this.http.request({
      method: "POST",
      path: `/v0/domains/${encodePath(domainId)}/verify`
    });
  }

  get(domainId: string): Promise<Domain> {
    return this.http.request({
      method: "GET",
      path: `/v0/domains/${encodePath(domainId)}`
    });
  }

  update(
    domainId: string,
    input: WithClientIdAlias<UpdateDomainInput>
  ): Promise<Domain> {
    return this.http.request({
      method: "PATCH",
      path: `/v0/domains/${encodePath(domainId)}`,
      body: mapClientId(input)
    });
  }
}

class PodsResource {
  constructor(private readonly http: HttpClient) {}

  list(params: ListParams = {}): Promise<ListResponse<"pods", Pod>> {
    return this.http.request({
      method: "GET",
      path: "/v0/pods",
      query: { ...params }
    });
  }

  create(input: WithClientIdAlias<CreatePodInput> = {}): Promise<Pod> {
    return this.http.request({
      method: "POST",
      path: "/v0/pods",
      body: mapClientId(input)
    });
  }

  get(podId: string): Promise<Pod> {
    return this.http.request({
      method: "GET",
      path: `/v0/pods/${encodePath(podId)}`
    });
  }

  delete(podId: string): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/v0/pods/${encodePath(podId)}`
    });
  }
}

class ApiKeysResource {
  constructor(private readonly http: HttpClient) {}

  list(params: ListParams = {}): Promise<ListResponse<"api_keys", ApiKey>> {
    return this.http.request({
      method: "GET",
      path: "/v0/api-keys",
      query: { ...params }
    });
  }

  create(input: WithClientIdAlias<CreateApiKeyInput> = {}): Promise<ApiKey> {
    return this.http.request({
      method: "POST",
      path: "/v0/api-keys",
      body: mapClientId(input)
    });
  }

  delete(apiKeyId: string): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/v0/api-keys/${encodePath(apiKeyId)}`
    });
  }

  /** Rename a key (PATCH returns `{key_id, name}`). */
  update(
    apiKeyId: string,
    input: UpdateApiKeyInput
  ): Promise<UpdateApiKeyResult> {
    return this.http.request({
      method: "PATCH",
      path: `/v0/api-keys/${encodePath(apiKeyId)}`,
      body: input
    });
  }
}

class SuppressionsResource {
  constructor(private readonly http: HttpClient) {}

  list(
    params: ListSuppressionsParams = {}
  ): Promise<ListResponse<"suppressions", Suppression>> {
    return this.http.request({
      method: "GET",
      path: "/v0/suppressions",
      query: { ...params }
    });
  }

  /** Manually suppress an address (reason `manual`). */
  add(input: CreateSuppressionInput): Promise<Suppression> {
    return this.http.request({
      method: "POST",
      path: "/v0/suppressions",
      body: input
    });
  }

  remove(address: string): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/v0/suppressions/${encodePath(address)}`
    });
  }

  batch(input: BatchSuppressionInput): Promise<SuppressionBatchResult> {
    return this.http.request({
      method: "POST",
      path: "/v0/suppressions/batch",
      body: input
    });
  }
}

class TemplatesResource {
  constructor(private readonly http: HttpClient) {}

  list(params: ListParams = {}): Promise<ListResponse<"templates", Template>> {
    return this.http.request({
      method: "GET",
      path: "/v0/templates",
      query: { ...params }
    });
  }

  create(input: WithClientIdAlias<CreateTemplateInput>): Promise<Template> {
    return this.http.request({
      method: "POST",
      path: "/v0/templates",
      body: mapClientId(input)
    });
  }

  get(templateId: string): Promise<Template> {
    return this.http.request({
      method: "GET",
      path: `/v0/templates/${encodePath(templateId)}`
    });
  }

  update(templateId: string, input: UpdateTemplateInput): Promise<Template> {
    return this.http.request({
      method: "PATCH",
      path: `/v0/templates/${encodePath(templateId)}`,
      body: input
    });
  }

  delete(templateId: string): Promise<void> {
    return this.http.request({
      method: "DELETE",
      path: `/v0/templates/${encodePath(templateId)}`
    });
  }

  /** Mark the template sendable (status → `published`). */
  publish(templateId: string): Promise<Template> {
    return this.http.request({
      method: "POST",
      path: `/v0/templates/${encodePath(templateId)}/publish`
    });
  }

  /** Clone a template into a new draft. */
  duplicate(templateId: string): Promise<Template> {
    return this.http.request({
      method: "POST",
      path: `/v0/templates/${encodePath(templateId)}/duplicate`
    });
  }
}

class AuthResource {
  constructor(private readonly http: HttpClient) {}

  me(): Promise<AuthMe> {
    return this.http.request({ method: "GET", path: "/v0/auth/me" });
  }
}

class MetricsResource {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v0/metrics` — bucketed event-count aggregates (spec §4 filters). */
  get(params: MetricsParams = {}): Promise<Metrics> {
    return this.http.request({
      method: "GET",
      path: "/v0/metrics",
      query: { ...params }
    });
  }

  usage(params: { month?: string } = {}): Promise<Usage> {
    return this.http.request({
      method: "GET",
      path: "/v0/metrics/usage",
      query: { ...params }
    });
  }
}

class UsageResource {
  constructor(private readonly http: HttpClient) {}

  /** `GET /v0/usage` — current-month plan counters. */
  get(): Promise<PlanUsage> {
    return this.http.request({ method: "GET", path: "/v0/usage" });
  }
}

/**
 * AgentMail-shape-compatible client (§0.2, §11):
 * `new WzrdMailClient({ apiKey })` → `client.inboxes.messages.send(inboxId, {…})`.
 */
export class WzrdMailClient {
  readonly inboxes: InboxesResource;
  readonly webhooks: WebhooksResource;
  readonly agent: AgentResource;
  readonly domains: DomainsResource;
  readonly pods: PodsResource;
  readonly apiKeys: ApiKeysResource;
  readonly auth: AuthResource;
  readonly metrics: MetricsResource;
  readonly usage: UsageResource;
  readonly suppressions: SuppressionsResource;
  readonly templates: TemplatesResource;

  constructor(options: WzrdMailClientOptions = {}) {
    const http = new HttpClient(options);
    this.inboxes = new InboxesResource(http);
    this.webhooks = new WebhooksResource(http);
    this.agent = new AgentResource(http);
    this.domains = new DomainsResource(http);
    this.pods = new PodsResource(http);
    this.apiKeys = new ApiKeysResource(http);
    this.auth = new AuthResource(http);
    this.metrics = new MetricsResource(http);
    this.usage = new UsageResource(http);
    this.suppressions = new SuppressionsResource(http);
    this.templates = new TemplatesResource(http);
  }
}
