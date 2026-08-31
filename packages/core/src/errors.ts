import { z } from "zod";

/** AgentMail-shape error envelope: `{"name": …, "message": …}` (§7). */
export const ErrorName = z.enum([
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "message_too_large",
  "plan_limit_exceeded",
  "suppressed_recipient",
  "internal_error"
]);
export type ErrorName = z.infer<typeof ErrorName>;

export const ErrorEnvelope = z.object({
  name: ErrorName,
  message: z.string()
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const ERROR_STATUS: Record<ErrorName, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  message_too_large: 413,
  plan_limit_exceeded: 403,
  suppressed_recipient: 400,
  internal_error: 500
};

export class ApiError extends Error {
  constructor(
    override readonly name: ErrorName,
    override readonly message: string
  ) {
    super(message);
  }

  get status(): number {
    return ERROR_STATUS[this.name];
  }

  toEnvelope(): ErrorEnvelope {
    return { name: this.name, message: this.message };
  }
}
