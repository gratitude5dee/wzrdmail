export function ListsPage() {
  return (
    <div>
      <div className="page-head">
        <h1>Allow &amp; Block Lists</h1>
      </div>
      <div className="grid two">
        {(["Receive", "Send", "Reply"] as const).map((direction) => (
          <div key={direction} className="card">
            <h3>{direction}</h3>
            <p className="dim">
              Allow and block addresses or domain patterns (<span className="mono">*@spam.com</span>)
              for {direction.toLowerCase()} traffic.
            </p>
            <div className="empty">
              List management ships in the next console milestone. Bounce and complaint
              suppressions are already enforced automatically at send time.
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
