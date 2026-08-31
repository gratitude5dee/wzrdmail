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
