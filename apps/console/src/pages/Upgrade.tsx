import { useSession } from "../session";

interface PlanCard {
  id: string;
  name: string;
  price: string;
  features: string[];
}

const PLANS: PlanCard[] = [
  {
    id: "free",
    name: "Free",
    price: "$0/mo",
    features: ["3 inboxes", "3,000 emails/mo", "3 GB storage", "100 sends/day", "1 seat"]
  },
  {
    id: "developer",
    name: "Developer",
    price: "$20/mo",
    features: [
      "10 inboxes",
      "10,000 emails/mo",
      "10 GB storage",
      "10 custom domains",
      "2 seats"
    ]
  },
  {
    id: "startup",
    name: "Startup",
    price: "$200/mo",
    features: [
      "150 inboxes",
      "150,000 emails/mo",
      "100 GB storage",
      "150 custom domains",
      "10 seats"
    ]
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Contact us",
    features: ["Unlimited everything", "Custom SLAs", "Dedicated support"]
  }
];

export function UpgradePage() {
  const { session } = useSession();
  return (
    <div>
      <div className="page-head">
        <h1>Plans</h1>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            className="card"
            style={plan.id === session.plan ? { borderColor: "var(--accent)" } : undefined}
          >
            <h3 style={{ marginTop: 0 }}>
              {plan.name}{" "}
              {plan.id === session.plan && <span className="chip accent">current</span>}
            </h3>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{plan.price}</div>
            <ul>
              {plan.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {plan.id !== session.plan && plan.id !== "free" && (
              <button className="btn primary" disabled title="Stripe checkout ships next">
                {plan.id === "enterprise" ? "Contact us" : "Upgrade"}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="dim" style={{ marginTop: 14 }}>
        Stripe checkout is landing in the billing milestone; until then, contact support to change
        plans. Every limit above is enforced server-side.
      </p>
    </div>
  );
}
