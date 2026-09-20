/**
 * Who is making an MCP request, and how they proved it (muse.md §4.3, §5).
 *
 * Both credential kinds end at the same place: a `wm_` API key that
 * api.wzrd.tech validates on every call. The distinction is kept because it
 * decides which transport lane runs — an OAuth connection is a hosted consumer
 * agent and always gets JSON, a key could be any client and keeps whatever it
 * asked for.
 */
export interface Principal {
  /** How the caller authenticated. */
  kind: "api_key" | "oauth";
  /** The `wm_` key every upstream call is made with. */
  apiKey: string;
  /** Granted permissions, known only for OAuth grants; undefined means "all". */
  permissions?: readonly string[];
  /** The single inbox an OAuth grant is pinned to, when it has one. */
  inboxId?: string;
}
