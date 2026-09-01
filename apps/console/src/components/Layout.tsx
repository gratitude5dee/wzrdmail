import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api";
import { useSession } from "../session";
import { Icon, type IconName } from "./Icon";

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

  const item = (to: string, icon: IconName, label: string, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => `navlink${isActive ? " active" : ""}`}>
      <Icon name={icon} />
      {label}
    </NavLink>
  );

  const orgLabel = session.name || session.email;

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="mail" size={15} />
          </span>
          wzrdmail
        </div>
        <div className="org">
          <span className="org-avatar">{orgLabel.slice(0, 1).toUpperCase()}</span>
          <span className="org-meta">
            <span className="name">{orgLabel}</span>
            <span className="plan">{PLAN_LABELS[session.plan] ?? session.plan}</span>
          </span>
        </div>
        {item("/", "overview", "Overview", true)}
        {item("/inboxes", "inbox", "Inboxes")}
        {item("/metrics", "chart", "Metrics")}
        <div className="section">Configuration</div>
        {item("/domains", "globe", "Domains")}
        {item("/webhooks", "zap", "Webhooks")}
        {item("/api-keys", "key", "API Keys")}
        {item("/lists", "shield", "Lists")}
        <div className="spacer" />
        {item("/settings", "settings", "Settings")}
        <NavLink to="/upgrade" className="navlink upgrade">
          <Icon name="upgrade" />
          Upgrade
        </NavLink>
        <a className="navlink" href="https://mail.wzrd.tech/docs" target="_blank" rel="noreferrer">
          <Icon name="help" />
          Help
        </a>
        <div className="sidebar-user">
          <span className="org-avatar">{(session.email || "?").slice(0, 1).toUpperCase()}</span>
          <span className="org-meta">
            <span className="name">{session.name || "you"}</span>
            <span className="plan">{session.email}</span>
          </span>
          <button className="icon-only" title="Sign out" aria-label="Sign out" onClick={() => void signOut()}>
            <Icon name="logout" />
          </button>
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
