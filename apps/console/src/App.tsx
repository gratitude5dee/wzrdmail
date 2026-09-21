import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, type Session } from "./api";
import { Layout } from "./components/Layout";
import { SessionContext } from "./session";
import { ApiKeysPage } from "./pages/ApiKeys";
import { DomainsPage } from "./pages/Domains";
import { InboxDetailPage } from "./pages/InboxDetail";
import { InboxesPage } from "./pages/Inboxes";
import { ListsPage } from "./pages/Lists";
import { LoginPage } from "./pages/Login";
import { MuseConnectPage } from "./pages/MuseConnect";
import { MetricsPage } from "./pages/Metrics";
import { OverviewPage } from "./pages/Overview";
import { SettingsPage } from "./pages/Settings";
import { UpgradePage } from "./pages/Upgrade";
import { WebhooksPage } from "./pages/Webhooks";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSession(await api<Session>("/console/session"));
    } catch (err) {
      setSession(null);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  if (loading) return <div className="login-wrap dim">Loading…</div>;
  // Air always sends users through the existing Thirdweb-powered WZRDMail
  // sign-in. Once the session is available, this route creates the one-use
  // server-to-server handoff and navigates back to Air's consent flow.
  if (window.location.pathname === "/connect/muse") {
    if (!session) return <LoginPage onLogin={refresh} />;
    return <MuseConnectPage signedIn />;
  }
  if (!session) return <LoginPage onLogin={refresh} />;

  return (
    <SessionContext.Provider value={{ session, refresh, setSession }}>
      <Layout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/inboxes" element={<InboxesPage />} />
          <Route path="/inboxes/:inboxId/*" element={<InboxDetailPage />} />
          <Route path="/metrics" element={<MetricsPage />} />
          <Route path="/domains" element={<DomainsPage />} />
          <Route path="/webhooks" element={<WebhooksPage />} />
          <Route path="/api-keys" element={<ApiKeysPage />} />
          <Route path="/lists" element={<ListsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/upgrade" element={<UpgradePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </SessionContext.Provider>
  );
}
