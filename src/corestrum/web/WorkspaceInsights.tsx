import { useMemo, useState } from "react";
import { ArrowUpRight, Activity, FileText, Workflow, ShieldCheck, Layers3 } from "lucide-react";
import { AGENTS } from "../catalog";
import { Reveal } from "./motion";

type Report = { id: string; agent: string; state: string; started: number };
type Routine = { enabled: boolean | number };
export function WorkspaceInsights({ reports = [], routines = [], ledgerIntact, onNavigate, compact = false }: {
  reports?: Report[]; routines?: Routine[]; ledgerIntact?: boolean; onNavigate: (page: string) => void; compact?: boolean;
}) {
  const [period, setPeriod] = useState(7);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const days = useMemo(() => Array.from({ length: period }, (_, i) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - period + i + 1);
    const end = new Date(date); end.setDate(end.getDate() + 1);
    return { date, count: reports.filter(r => r.started >= date.getTime() && r.started < end.getTime()).length };
  }), [period, reports]);
  const total = days.reduce((n, d) => n + d.count, 0);
  const maximum = Math.max(1, ...days.map(d => d.count));
  const ready = reports.filter(r => r.state === "draft_ready").length;
  const active = routines.filter(r => r.enabled).length;
  const selected = selectedDay === null ? null : days[selectedDay];
  return <section className="workspace-insights" aria-label="Workspace activity insights">
    {!compact && <div className="metric-grid">
      {[
        { label: "Drafts to explore", value: ready, note: "In your recent reports", icon: FileText, page: "Evidence" },
        { label: "Your routines", value: routines.length, note: `${active} enabled · ${routines.length - active} paused`, icon: Workflow, page: "Automations" },
        { label: "Specialist roles", value: AGENTS.length, note: "One coordinated team", icon: Layers3, page: "Team" },
        { label: "Activity chain", value: ledgerIntact ? "Intact" : "Review", note: "Local record integrity", icon: ShieldCheck, page: "Evidence" },
      ].map((item, i) => <Reveal key={item.label} delay={i * 40}>
        <button className={`metric-card glass-card metric-${i}`} onClick={() => onNavigate(item.page)}>
          <span className="metric-label"><item.icon size={17} />{item.label}<ArrowUpRight size={15} /></span>
          <strong>{item.value}</strong><span className="metric-note">{item.note}</span>
        </button>
      </Reveal>)}
    </div>}
    <div className="insight-grid">
      <Reveal className="activity-chart glass-card">
        <div className="insight-heading"><div><span className="eyebrow"><Activity size={13} /> THE RHYTHM OF YOUR WORK</span><h2>Agent activity</h2></div>
          <div className="segmented-control" aria-label="Activity period">{[7, 14].map(n => <button key={n} aria-pressed={period === n} onClick={() => { setPeriod(n); setSelectedDay(null); }}>{n} days</button>)}</div>
        </div>
        <div className="chart-summary"><strong>{total}<small> recorded runs</small></strong><span role="status">{selected ? `${selected.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${selected.count} ${selected.count === 1 ? "run" : "runs"}` : total ? "Hover or focus a day to explore" : reports.length ? "No runs in this period yet" : "Your first run starts the story"}</span></div>
        <div className="bar-chart" role="group" aria-label={`Recorded runs in the last ${period} days`}>
          {days.map((d, i) => <button key={d.date.toISOString()} className={`chart-column ${selectedDay === i ? "is-inspected" : ""}`} onMouseEnter={() => setSelectedDay(i)} onMouseLeave={() => setSelectedDay(null)} onFocus={() => setSelectedDay(i)} onBlur={() => setSelectedDay(null)} onClick={() => setSelectedDay(i)} aria-label={`${d.date.toLocaleDateString()}: ${d.count} runs`}>
            <span className="bar-track"><span className="bar-fill" style={{ height: `${d.count ? Math.max(6, d.count / maximum * 100) : 0}%`, animationDelay: `${i * 30}ms` }} /><span className="bar-zero" /></span>
            <span className="bar-label">{period === 7 ? d.date.toLocaleDateString(undefined, { weekday: "short" }) : d.date.getDate()}</span>
          </button>)}
        </div>
        <p className="chart-source">Based on the latest {reports.length} local reports (up to 40). Recorded runs include every outcome.</p>
      </Reveal>
      <Reveal className="team-activity glass-card" delay={80}>
        <div className="insight-heading"><div><span className="eyebrow">WORK, IN CONCERT</span><h2>Across your team</h2></div><span className="tiny-pill">RECENT RUNS</span></div>
        <div className="role-meter-list">{AGENTS.map((role, i) => {
          const count = reports.filter(r => r.agent === role.id).length;
          return <button key={role.id} className="role-meter" onClick={() => onNavigate("Team")} aria-label={`${role.name}: ${count} recent runs. View team`}>
            <span className={`role-dot role-color-${i}`} /><span>{role.name}</span><strong>{count}</strong>
            <span className="role-meter-track"><span className={`role-color-${i}`} style={{ transform: `scaleX(${reports.length ? count / reports.length : 0})` }} /></span>
          </button>;
        })}</div>
        <p className="chart-source">Each role has a purpose. Every result stays yours to review.</p>
      </Reveal>
    </div>
  </section>;
}
