export interface ActivityPoint {
  bucket: string;
  sent: number;
  received: number;
}

const W = 720;
const H = 160;
const PAD = 6;

function buildPath(points: ActivityPoint[], pick: (p: ActivityPoint) => number, max: number) {
  const n = points.length;
  const step = n > 1 ? (W - PAD * 2) / (n - 1) : 0;
  return points
    .map((p, i) => {
      const x = PAD + i * step;
      const y = H - PAD - (pick(p) / max) * (H - PAD * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function ActivityChart({ points }: { points: ActivityPoint[] }) {
  const max = Math.max(1, ...points.map((p) => Math.max(p.sent, p.received)));
  const sentPath = buildPath(points, (p) => p.sent, max);
  const recvPath = buildPath(points, (p) => p.received, max);
  const first = points[0]?.bucket ?? "";
  const last = points[points.length - 1]?.bucket ?? "";
  return (
    <div className="activity-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Email activity chart">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={PAD + (H - PAD * 2) * f}
            y2={PAD + (H - PAD * 2) * f}
            className="gridline"
          />
        ))}
        <path d={recvPath} className="line recv" />
        <path d={sentPath} className="line sent" />
      </svg>
      <div className="axis">
        <span>{first}</span>
        <span>{last}</span>
      </div>
      <div className="legend">
        <span className="legend-item">
          <i className="dot sent" /> sent
        </span>
        <span className="legend-item">
          <i className="dot recv" /> received
        </span>
      </div>
    </div>
  );
}
