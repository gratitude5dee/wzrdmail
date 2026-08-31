import { Link } from "react-router-dom";

export function CapacityBar({
  used,
  limit,
  unit
}: {
  used: number;
  limit: number | null;
  unit: string;
}) {
  if (limit === null) {
    return (
      <div className="capacity">
        <div className="meta">
          <span>
            {used.toLocaleString()} {unit}
          </span>
          <span>unlimited</span>
        </div>
      </div>
    );
  }
  const pct = limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  const remaining = Math.max(0, limit - used);
  return (
    <div className="capacity">
      <div className="bar">
        <div className={`fill${remaining === 0 ? " full" : ""}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="meta">
        <span>
          {used.toLocaleString()} / {limit.toLocaleString()} {unit}
        </span>
        <span>
          {remaining === 0 ? (
            <Link to="/upgrade">Compare plans ↗</Link>
          ) : (
            `${remaining.toLocaleString()} remaining`
          )}
        </span>
      </div>
    </div>
  );
}
