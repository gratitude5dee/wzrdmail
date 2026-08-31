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
  CreateDomainInput,
  CreateWebhookInput,
  Domain,
  ListMessagesParams,
  ListParams,
  ListResponse,
  Webhook
} from "./types.js";

export type WzrdMailClientOptions = HttpClientOptions;

type SignUpInput = z.infer<typeof AgentSignUpInput>;
type VerifyInput = z.infer<typeof AgentVerifyInput>;

class MessagesResource {
  constructor(private readonly http: HttpClient) {}

  send(inboxId: string, input: SendMessageInput): Promise<Message> {
    return this.http.request({
      method: "POST",
      path: `/v0/inboxes/${encodePath(inboxId)}/messages/send`,
      body: input
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
}

class InboxesResource {
  readonly messages: MessagesResource;
  readonly threads: InboxThreadsResource;

  constructor(private readonly http: HttpClient) {
    this.messages = new MessagesResource(http);
    this.threads = new InboxThreadsResource(http);
  }

  create(input: CreateInboxInput = {}): Promise<Inbox> {
    return this.http.request({
      method: "POST",
      path: "/v0/inboxes",
      body: input
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
}

class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  create(input: CreateWebhookInput): Promise<Webhook> {
    return this.http.request({
      method: "POST",
      path: "/v0/webhooks",
      body: input
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

  create(input: CreateDomainInput): Promise<Domain> {
    return this.http.request({
      method: "POST",
      path: "/v0/domains",
      body: input
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

  constructor(options: WzrdMailClientOptions = {}) {
    const http = new HttpClient(options);
    this.inboxes = new InboxesResource(http);
    this.webhooks = new WebhooksResource(http);
    this.agent = new AgentResource(http);
    this.domains = new DomainsResource(http);
  }
}
