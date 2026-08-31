import { ErrorEnvelope } from "@wzrdmail/core";

/**
 * Error thrown for any non-2xx API response. Carries the AgentMail-shape
 * error envelope (`{name, message}`, §7) plus the HTTP status.
 */
export class WzrdmailError extends Error {
  override readonly name: string;
  readonly status: number;
  readonly body: { name: string; message: string };

  constructor(status: number, body: { name: string; message: string }) {
    super(body.message);
    this.name = body.name;
    this.status = status;
    this.body = body;
  }
}

export function parseErrorBody(status: number, raw: unknown): WzrdmailError {
  const parsed = ErrorEnvelope.safeParse(raw);
  if (parsed.success) return new WzrdmailError(status, parsed.data);
  return new WzrdmailError(status, {
    name: "internal_error",
    message: `unexpected error response (HTTP ${status})`
  });
}
