export const extractApiKey = (request: Request): string | null => {
  const headerKey = request.headers.get("x-api-key")?.trim();
  if (headerKey !== undefined && headerKey !== "") return headerKey;
  const authorization = request.headers.get("authorization");
  if (authorization !== null && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token !== "") return token;
  }
  return null;
};

/**
 * partyserver delivers `props` only to the first `onStart()`, so a session's
 * `this.props.apiKey` is permanently the key that created it. Every request
 * routed into the session Durable Object must be re-checked against that
 * bound key before any MCP traffic is handled.
 */
export const sessionKeyGuard = (
  request: Request,
  boundKey: string | undefined
): Response | null => {
  if (boundKey !== undefined && extractApiKey(request) === boundKey) {
    return null;
  }
  return Response.json(
    {
      name: "unauthorized",
      message: "api key does not match the key this MCP session was created with"
    },
    { status: 401 }
  );
};
