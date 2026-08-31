import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api";
import { useSession } from "../session";

const PLAN_LABELS: Record<string, string> = {
  free: "Free Tier",
  developer: "Developer",
  startup: "Startup",
  enterprise: "Enterprise"
};

export function Layout({ children }: { children: ReactNode }) {
  const { session, setSession } = useSession();

  const signOut = async () => {
    await api("/console/logout", { method: "POST", body: "{}" });
    // The thirdweb wallet persists in the browser; flag the explicit logout
    // so the login page disconnects it instead of auto-signing back in.
    localStorage.setItem("wzrdmail:signed-out", "1");
    setSession(null);
    window.location.href = "/";
  };

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="org">
          <div className="name">{session.name || session.email}</div>
          <div className="plan">{PLAN_LABELS[session.plan] ?? session.plan}</div>
        </div>
        <NavLink to="/" end className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          Overview
        </NavLink>
        <NavLink to="/inboxes" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          Inboxes
        </NavLink>
        <NavLink to="/metrics" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          Metrics
        </NavLink>
        <div className="section">Configuration</div>
        <NavLink to="/domains" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          Domains
        </NavLink>
        <NavLink to="/webhooks" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          Webhooks
        </NavLink>
        <NavLink to="/api-keys" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          API Keys
        </NavLink>
        <NavLink to="/lists" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          Lists
        </NavLink>
        <div className="spacer" />
        <NavLink to="/settings" className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
          Settings
        </NavLink>
        <NavLink to="/upgrade" className="navlink upgrade">
          Upgrade
        </NavLink>
        <a className="navlink" href="https://mail.wzrd.tech/docs" target="_blank" rel="noreferrer">
          Help
        </a>
        <button className="btn sm" onClick={() => void signOut()}>
          Sign out
        </button>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
