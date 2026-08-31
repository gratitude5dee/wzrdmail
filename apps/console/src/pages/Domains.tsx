import { Link } from "react-router-dom";
import { useSession } from "../session";

export function DomainsPage() {
  const { session } = useSession();
  const gated = session.plan === "free";
  return (
    <div>
      <div className="page-head">
        <h1>Domains</h1>
      </div>
      {gated && (
        <div className="card" style={{ marginBottom: 14 }}>
          <b>Custom domains require a paid plan.</b>{" "}
          <span className="dim">
            Upgrade to Developer or Startup to send from your own domain.
          </span>{" "}
          <Link to="/upgrade">Compare plans ↗</Link>
        </div>
      )}
      <div className="card empty">
        <h3>No custom domains yet</h3>
        Every organization can use <span className="mono">@wzrd.tech</span> out of the box.
        Custom-domain onboarding (DNS records, live verification) ships in the next console
        milestone — see the roadmap in{" "}
        <a href="https://mail.wzrd.tech/docs" target="_blank" rel="noreferrer">
          the docs
        </a>
        .
      </div>
    </div>
  );
}
