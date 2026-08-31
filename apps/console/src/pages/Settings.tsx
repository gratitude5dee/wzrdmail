import { useSession } from "../session";

export function SettingsPage() {
  const { session } = useSession();
  return (
    <div>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div className="card" style={{ maxWidth: 640, marginBottom: 14 }}>
        <h3>Organization</h3>
        <div className="field">
          <label>Name</label>
          <div>{session.name || <span className="dim">unnamed</span>}</div>
        </div>
        <div className="field">
          <label>Organization ID</label>
          <div className="mono">{session.organization_id}</div>
        </div>
        <div className="field">
          <label>Owner email</label>
          <div>{session.email}</div>
        </div>
        <div className="field">
          <label>Verification</label>
          <div>
            <span className={`chip ${session.verified ? "green" : "red"}`}>
              {session.verified ? "verified" : "unverified"}
            </span>
            {!session.verified && (
              <span className="dim">
                {" "}
                — unverified organizations can only email their owner address.
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="card" style={{ maxWidth: 640 }}>
        <h3>Members &amp; seats</h3>
        <p className="dim">
          Seat invitations ship in the next console milestone. Your plan&apos;s seat limit is
          enforced server-side.
        </p>
      </div>
    </div>
  );
}
