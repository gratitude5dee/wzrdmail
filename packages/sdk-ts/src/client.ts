import type {
  AgentSignUpInput,
  AgentVerifyInput,
  CreateInboxInput,
  Inbox,
  Message,
  SendMessageInput,
  Thread
} from "@wzrdmail/core";
import { z } from "zod";
import { HttpClient, encodePath, type HttpClientOptions } from "./http.js";
import type {
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
}

class AuthResource {
  constructor(private readonly http: HttpClient) {}

  me(): Promise<AuthMe> {
    return this.http.request({ method: "GET", path: "/v0/auth/me" });
  }
}

class MetricsResource {
  constructor(private readonly http: HttpClient) {}

  usage(params: { month?: string } = {}): Promise<Usage> {
    return this.http.request({
      method: "GET",
      path: "/v0/metrics/usage",
      query: { ...params }
    });
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
  }
}
