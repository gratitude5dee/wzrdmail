import { Icon } from "./Icon";

const R = 56;
const TICKS = 48;

export function HealthRing({ percent, label }: { percent: number | null; label: string }) {
  const active = percent === null ? 0 : Math.round((percent / 100) * TICKS);
  return (
    <div className="health-ring" role="img" aria-label={`${label}: ${percent === null ? "no data" : `${percent.toFixed(1)}%`}`}>
      <svg viewBox="0 0 140 140">
        {Array.from({ length: TICKS }, (_, i) => {
          const angle = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
          const x1 = 70 + Math.cos(angle) * R;
          const y1 = 70 + Math.sin(angle) * R;
          const x2 = 70 + Math.cos(angle) * (R + 10);
          const y2 = 70 + Math.sin(angle) * (R + 10);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              className={i < active ? "tick on" : "tick"}
            />
          );
        })}
      </svg>
      <div className="center">
        <span className="ring-icon">
          <Icon name="mail" size={18} />
        </span>
        <span className="ring-label">{label}</span>
        <span className="ring-value">{percent === null ? "—" : `${percent.toFixed(1)}%`}</span>
      </div>
    </div>
  );
}
