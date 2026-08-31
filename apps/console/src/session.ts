import { createContext, useContext } from "react";
import type { Session } from "./api";

export interface SessionState {
  session: Session;
  refresh: () => Promise<void>;
  setSession: (s: Session | null) => void;
}

export const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside provider");
  return ctx;
}
