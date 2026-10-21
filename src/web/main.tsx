import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  Home,
  Link2,
  Loader2,
  Settings,
  X,
  ArrowUpRight,
} from "lucide-react";
import "@fontsource-variable/inter";
import { brand } from "./brand";
import type { Org, Role, Run, Snapshot } from "../contracts";
import "./styles.css";

type Page = "Overview" | "Connections" | "Activity" | "Settings";
const money = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    v / 1_000_000,
  );
const labels: Record<string, string> = {
  "workspace.provisioned": "Fictional workspace provisioned",
  "issue.read_scoped": "Issue read within approved scope",
  "action.prepared": "Follow-up prepared",
  "approval.requested": "Approval requested",
  "action.approved": "Action approved by administrator",
  "action.dispatched": "Action sent to fixture bridge",
  "action.verified": "Fixture follow-up verified",
  "action.outcome_unknown": "Response interrupted · outcome unknown",
  "action.reconciled": "Existing follow-up found · no duplicate",
  "connection.revoked": "Connector access revoked",
  "connection.fixture_verified": "Fixture connection verified",
  "budget.updated": "Demo spending settings updated",
  "usage.reserved": "Demo AI spend reserved",
  "usage.settled": "Demo AI usage settled",
};
const stateLabel = {
  waiting_approval: "Awaiting approval",
  approved: "Approved",
  executing: "In progress",
  outcome_unknown: "Needs reconciliation",
  verified: "Verified in fixture",
};
const messageFor = (code: string) =>
  ({
    BUDGET_EXCEEDED:
      "This workflow would exceed your demo budget. Review your spending limit in Settings.",
    CONNECTION_REVOKED:
      "This connection is disconnected. Reconnect it before continuing.",
    APPROVAL_STALE:
      "The data or permissions changed. Run a new workflow and review its updated action.",
    OWNER_REQUIRED:
      "This demo session is read-only. Switch to administrator in Settings to make changes.",
    SESSION_REQUIRED:
      "Your demo session expired. Choose a workspace to continue.",
    BUDGET_BELOW_COMMITTED_USAGE:
      "The limit cannot be lower than spend already used or reserved.",
    RECONCILIATION_PENDING:
      "No receipt is available yet. The action remains held and will not be sent again.",
  })[code] ?? `The request was not completed (${code}).`;

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<Page>("Overview");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [reviewId, setReviewId] = useState<string | null>(null),
    [loseResponse, setLoseResponse] = useState(false);
  const [limit, setLimit] = useState("5.00"),
    [funding, setFunding] = useState<"byok" | "managed">("byok");
  const csrf = useRef(""),
    dialog = useRef<HTMLDialogElement>(null),
    epoch = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const review = snapshot?.runs.find((r) => r.id === reviewId);
  async function request(path: string, body?: unknown) {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...(body
        ? {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrf.current,
            },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "UNAVAILABLE");
    return data;
  }
  async function refresh() {
    const generation = epoch.current;
    const s = (await request("/api/snapshot")) as Snapshot;
    if (generation !== epoch.current) return;
    setSnapshot(s);
    setLimit((s.budget.limit / 1_000_000).toFixed(2));
    setFunding(s.budget.funding);
  }
  async function login(customer: Org, role: Role = "owner") {
    epoch.current++;
    setBusy(true);
    setReviewId(null);
    setError("");
    setNotice("");
    setSnapshot(null);
    try {
      const s = await request("/api/demo-session", { customer, role });
      csrf.current = s.csrf;
      await refresh();
    } catch (e) {
      setError(messageFor((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void (async () => {
      try {
        const s = await request("/api/session");
        csrf.current = s.csrf;
        await refresh();
      } catch {
        await login("cedar");
      }
    })();
  }, []);
  useEffect(() => {
    if (review && !dialog.current?.open) {
      setLoseResponse(false);
      dialog.current?.showModal();
    } else if (!review) dialog.current?.close();
  }, [reviewId, Boolean(review)]);
  async function command(command: string, input: Record<string, unknown>) {
    return request("/api/command", { command, input });
  }
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await refresh();
      setNotice(success);
    } catch (e) {
      setError(messageFor((e as Error).message));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const owner = snapshot?.role === "owner";
  const pending =
    snapshot?.runs.filter((r) =>
      ["waiting_approval", "approved", "outcome_unknown"].includes(r.state),
    ) ?? [];
  const currentRun = pending[0] ?? snapshot?.runs[0];
  const runDemo = () =>
    void act(
      () =>
        command("start", {
          issueId: snapshot!.issueId,
          key: crypto.randomUUID(),
        }),
      "A scoped issue was read and a follow-up is ready for review. No live AI was used.",
    );
  const nav = [
    { name: "Overview", icon: Home },
    { name: "Connections", icon: Link2 },
    { name: "Activity", icon: Activity },
    { name: "Settings", icon: Settings },
  ] as const;
  const showActivity = () => {
    setPage("Activity");
    setReviewId(null);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Workspace navigation">
        <div className="brand">
          <span>{brand.name}</span>
          <small>{brand.label}</small>
        </div>
        <div className="workspace-select">
          <label htmlFor="workspace">Demo workspace</label>
          <select
            id="workspace"
            value={snapshot?.org ?? "cedar"}
            disabled={busy}
            onChange={(e) => void login(e.target.value as Org)}
          >
            <option value="cedar">Cedar SaaS</option>
            <option value="mesa">Mesa SaaS</option>
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </div>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={page === name ? "nav-item active" : "nav-item"}
              onClick={() => {
                setPage(name);
                setError("");
                setNotice("");
              }}
              aria-current={page === name ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <button className="profile" onClick={() => setPage("Settings")}>
          <span className="avatar">{owner ? "DA" : "DV"}</span>
          <span>Demo {owner ? "administrator" : "viewer"}</span>
          <ArrowRight size={14} />
        </button>
      </aside>
      <main id="main" tabIndex={-1}>
        <div className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <b>{page}</b>
          </div>
          <span className="environment">
            <i />
            Synthetic environment
          </span>
        </div>
        <header className="page-header">
          <div>
            <h1>
              {page === "Overview" ? (
                <>
                  Work moves.
                  <br />
                  You stay in control.
                </>
              ) : page === "Connections" ? (
                <>Access, on your terms.</>
              ) : page === "Activity" ? (
                <>
                  Every action.
                  <br />A clear record.
                </>
              ) : (
                <>Set the boundaries.</>
              )}
            </h1>
            <p>
              {page === "Overview"
                ? "A clear view of your agents, their access, and what needs you."
                : page === "Connections"
                  ? "Choose what an agent can read and which actions it can propose."
                  : page === "Activity"
                    ? "Follow the evidence inside this customer’s environment."
                    : "Your team chooses the access, the approvals, and the spending limit."}
            </p>
          </div>
          {page === "Overview" && (
            <button
              className="button primary run-button"
              disabled={
                busy || !snapshot || !owner || !snapshot.connector.active
              }
              onClick={runDemo}
            >
              {busy ? <Loader2 className="spin" size={17} /> : null}Run demo
              workflow
              <ArrowRight size={17} />
            </button>
          )}
        </header>
        <div aria-live="polite" aria-atomic="true">
          {notice && (
            <div className="notice">
              <Check size={17} />
              <span>{notice}</span>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </div>
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {!snapshot ? (
          <div className="panel loading" role="status">
            <Loader2 className="spin" />
            Opening your isolated demo workspace…
          </div>
        ) : (
          <>
            {page === "Overview" && (
              <>
                <section className="metrics" aria-label="Workspace summary">
                  <div>
                    <strong>
                      {
                        snapshot.runs.filter(
                          (r) => r.state === "waiting_approval",
                        ).length
                      }
                    </strong>
                    <span>Awaiting approval</span>
                  </div>
                  <div>
                    <strong>{snapshot.connector.capabilities.length}</strong>
                    <span>Allowed capabilities</span>
                  </div>
                  <div>
                    <strong>
                      {money(snapshot.budget.spent)}{" "}
                      <small>of {money(snapshot.budget.limit)}</small>
                    </strong>
                    <span>Demo AI budget</span>
                  </div>
                </section>
                <div className="overview-grid">
                  <div className="work-column">
                    <section className="panel attention">
                      <div className="section-heading">
                        <h2>Needs your attention</h2>
                        <span>
                          {pending.length}{" "}
                          {pending.length === 1 ? "item" : "items"}
                        </span>
                      </div>
                      {currentRun ? (
                        <article className="task-card">
                          <div className="task-heading">
                            <div>
                              <h3>{currentRun.title}</h3>
                              <p>
                                {snapshot.name.split(" ")[0]} / Account Alpha
                              </p>
                            </div>
                            <span
                              className={`status ${currentRun.state === "verified" ? "success" : ""}`}
                            >
                              <i />
                              {stateLabel[currentRun.state]}
                            </span>
                          </div>
                          <dl className="intent">
                            <dt>Intent</dt>
                            <dd>
                              Prepare a follow-up for the engineering team.
                            </dd>
                            <dt>Read data</dt>
                            <dd>Issue title, status, account ID</dd>
                            <dt>Proposed action</dt>
                            <dd>Create internal follow-up</dd>
                          </dl>
                          <div className="button-row">
                            {currentRun.state === "outcome_unknown" ? (
                              <button
                                className="button primary"
                                disabled={busy || !owner}
                                onClick={() =>
                                  void act(
                                    () =>
                                      command("reconcile", {
                                        id: currentRun.id,
                                      }),
                                    "The existing fixture receipt was found. No duplicate action was sent.",
                                  )
                                }
                              >
                                Reconcile outcome
                                <ArrowRight size={16} />
                              </button>
                            ) : currentRun.state !== "verified" ? (
                              <button
                                className="button primary"
                                disabled={busy || !owner}
                                onClick={() => setReviewId(currentRun.id)}
                              >
                                Review action
                                <ArrowRight size={16} />
                              </button>
                            ) : (
                              <span className="verified-label">
                                <Check size={17} />
                                Follow-up verified
                              </span>
                            )}
                            <button
                              className="button secondary"
                              onClick={showActivity}
                            >
                              View evidence
                            </button>
                          </div>
                          {pending.length > 1 && (
                            <div className="more-runs">
                              {pending.slice(1, 5).map((r) => (
                                <button
                                  key={r.id}
                                  onClick={() => setReviewId(r.id)}
                                  disabled={!owner}
                                >
                                  {stateLabel[r.state]}{" "}
                                  <span>{r.id.slice(-8)}</span>
                                  <ArrowRight size={14} />
                                </button>
                              ))}
                            </div>
                          )}
                        </article>
                      ) : (
                        <div className="empty-state">
                          <div className="empty-marker">
                            <ArrowUpRight size={24} />
                          </div>
                          <h3>Ready when you are.</h3>
                          <p>
                            Run the demo workflow to read a fictional issue and
                            prepare an action for your review.
                          </p>
                          <span className="eyebrow">
                            Nothing runs without your boundaries.
                          </span>
                        </div>
                      )}
                    </section>
                    <section className="panel recent">
                      <div className="section-heading">
                        <h2>Recent activity</h2>
                        <button className="text-button" onClick={showActivity}>
                          View all activity
                          <ArrowRight size={16} />
                        </button>
                      </div>
                      <ActivityList snapshot={snapshot} compact />
                    </section>
                  </div>
                  <section className="panel guardrails">
                    <h2>Your guardrails</h2>
                    <ul>
                      <li>
                        <i className={snapshot.auditValid ? "" : "off"} />
                        <div>
                          <h3>Customer data isolated</h3>
                          <p>
                            A separate process and database for this workspace.
                          </p>
                        </div>
                      </li>
                      <li>
                        <i />
                        <div>
                          <h3>Actions need approval</h3>
                          <p>
                            Review the exact action before an agent can run it.
                          </p>
                        </div>
                      </li>
                      <li>
                        <i className={snapshot.connector.active ? "" : "off"} />
                        <div>
                          <h3>Connector access scoped</h3>
                          <p>
                            {snapshot.connector.active
                              ? "Two capabilities. One permitted account."
                              : "Disconnected. New access is blocked."}
                          </p>
                        </div>
                      </li>
                      <li>
                        <i />
                        <div>
                          <h3>Hard spending limit</h3>
                          <p>Usage is reserved before a simulated AI call.</p>
                        </div>
                      </li>
                    </ul>
                    <div className="guardrail-note">
                      <h3>Built for deliberate automation.</h3>
                      <p>
                        Give your team the power of AI agents with clear
                        boundaries, approvals, and an audit trail.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => setPage("Connections")}
                      >
                        View permissions
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  </section>
                </div>
              </>
            )}
            {page === "Connections" && (
              <div className="detail-grid">
                <section className="panel connection-panel">
                  <div className="section-heading">
                    <div className="connector-title">
                      <span className="connector-icon">
                        <Link2 />
                      </span>
                      <div>
                        <h2>Customer application bridge</h2>
                        <p>Synthetic adapter · {snapshot.name}</p>
                      </div>
                    </div>
                    <span
                      className={`status ${snapshot.connector.active ? "success" : ""}`}
                    >
                      {snapshot.connector.active
                        ? "Fixture connected"
                        : "Disconnected"}
                    </span>
                  </div>
                  <p className="intro">
                    Your application keeps its own database. Agents receive only
                    the fields and actions you explicitly allow.
                  </p>
                  <div className="permission-row">
                    <span className="number">01</span>
                    <div>
                      <h3>Read a support issue</h3>
                      <p>Account Alpha only · title, status, account ID</p>
                      <code>issue.read</code>
                    </div>
                    <span className="permission-badge">Read</span>
                  </div>
                  <div className="permission-row">
                    <span className="number">02</span>
                    <div>
                      <h3>Create an internal follow-up</h3>
                      <p>Account Alpha only · exact intent requires approval</p>
                      <code>followup.create</code>
                    </div>
                    <span className="permission-badge">Approval</span>
                  </div>
                  <div className="blocked-scope">
                    <b>Outside this grant</b>
                    <p>
                      Account Beta, other companies, arbitrary SQL, shell
                      commands, external destinations, and production
                      credentials.
                    </p>
                  </div>
                  <div className="button-row">
                    <button
                      className="button primary"
                      disabled={busy || !owner}
                      onClick={() =>
                        void act(async () => {
                          if (!snapshot.connector.active)
                            await command("connection", { active: true });
                          await command("read", { id: snapshot.issueId });
                        }, "The fixture bridge returned only Account Alpha’s allowed issue fields.")
                      }
                    >
                      {snapshot.connector.active
                        ? "Verify fixture connection"
                        : "Reconnect fixture"}
                      <ArrowRight size={16} />
                    </button>
                    {snapshot.connector.active && (
                      <button
                        className="button secondary"
                        disabled={busy || !owner}
                        onClick={() =>
                          void act(
                            () => command("connection", { active: false }),
                            "Access is revoked. Existing approvals are now stale.",
                          )
                        }
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </section>
                <aside className="panel quiet-panel">
                  <span className="eyebrow">Connection model</span>
                  <h2>One narrow doorway.</h2>
                  <p>
                    A customer-owned API or Supabase Edge Function will enforce
                    the same named capabilities in the first live integration.
                  </p>
                  <ol>
                    <li>Install the bridge in the customer’s application.</li>
                    <li>
                      Confirm the company, environment, and allowed accounts.
                    </li>
                    <li>
                      Choose fields and actions, then verify a denied read.
                    </li>
                  </ol>
                  <p className="small-note">
                    This prototype uses local fixtures. It does not connect to
                    Supabase, GitHub, or a live customer database. No
                    credentials are requested.
                  </p>
                </aside>
              </div>
            )}
            {page === "Activity" && (
              <section className="panel activity-page">
                <div className="section-heading">
                  <div>
                    <h2>Workspace audit trail</h2>
                    <p>Most recent 100 events · {snapshot.name}</p>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => {
                      window.location.assign("/api/audit-export");
                    }}
                  >
                    <Download size={16} />
                    Export evidence
                  </button>
                </div>
                <div className="integrity">
                  <i className={snapshot.auditValid ? "" : "off"} />
                  {snapshot.auditValid
                    ? "Local audit chain verified"
                    : "Audit integrity check failed"}
                  <span>
                    Append-only through the application · independent immutable
                    storage pending
                  </span>
                </div>
                <ActivityList snapshot={snapshot} />
              </section>
            )}
            {page === "Settings" && (
              <div className="detail-grid">
                <div className="stack">
                  <form
                    className="panel settings-panel"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const n = Number(limit);
                      if (!Number.isFinite(n) || n < 0 || n > 100) {
                        setError("Choose a demo limit between $0 and $100.");
                        return;
                      }
                      void act(
                        () =>
                          command("budget", {
                            limit: Math.round(n * 1_000_000),
                            funding,
                          }),
                        "Demo spending settings saved. No payment method or live provider is connected.",
                      );
                    }}
                  >
                    <span className="eyebrow">AI funding</span>
                    <h2>A limit you can rely on.</h2>
                    <p>
                      Both funding models share the same spending controls. All
                      usage here is simulated.
                    </p>
                    <fieldset disabled={busy || !owner}>
                      <legend>Funding model</legend>
                      <label className="radio-row">
                        <input
                          type="radio"
                          name="funding"
                          checked={funding === "byok"}
                          onChange={() => setFunding("byok")}
                        />
                        <span>
                          <b>Bring your own AI</b>
                          <small>
                            In the future, your provider API account pays for AI
                            usage.
                          </small>
                        </span>
                      </label>
                      <label className="radio-row">
                        <input
                          type="radio"
                          name="funding"
                          checked={funding === "managed"}
                          onChange={() => setFunding("managed")}
                        />
                        <span>
                          <b>Managed AI</b>
                          <small>
                            In the future, usage is funded through your platform
                            plan.
                          </small>
                        </span>
                      </label>
                      <label className="field-label" htmlFor="budget">
                        Demo spending limit (USD)
                      </label>
                      <div className="money-field">
                        <span>$</span>
                        <input
                          id="budget"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={limit}
                          onChange={(e) => setLimit(e.target.value)}
                          required
                        />
                      </div>
                      <p className="small-note">
                        {money(snapshot.budget.spent)} used ·{" "}
                        {money(snapshot.budget.held)} reserved. A workflow
                        reserves $0.10 and settles $0.04 of simulated usage.
                      </p>
                      <button className="button primary" type="submit">
                        Save spending settings
                        <ArrowRight size={16} />
                      </button>
                    </fieldset>
                  </form>
                  <section className="panel">
                    <h2>Demo identity</h2>
                    <p>
                      Test a read-only view or administrator permissions. This
                      local switch is not production authentication.
                    </p>
                    <label className="field-label" htmlFor="role">
                      Session role
                    </label>
                    <select
                      className="input"
                      id="role"
                      disabled={busy}
                      value={snapshot.role}
                      onChange={(e) =>
                        void login(snapshot.org, e.target.value as Role)
                      }
                    >
                      <option value="owner">Demo administrator</option>
                      <option value="viewer">Demo viewer · read only</option>
                    </select>
                  </section>
                </div>
                <aside className="panel quiet-panel">
                  <span className="eyebrow">Security foundations</span>
                  <h2>Readiness starts here.</h2>
                  <p>
                    Customer boundaries, least privilege, exact-action approval,
                    spend reservations, and audit evidence are implemented in
                    this synthetic prototype.
                  </p>
                  <div className="readiness-item">
                    <Check size={17} />
                    <span>Two separate customer runtimes</span>
                  </div>
                  <div className="readiness-item">
                    <Check size={17} />
                    <span>Server-enforced capabilities and roles</span>
                  </div>
                  <div className="readiness-item">
                    <Check size={17} />
                    <span>Revocation and interrupted-action recovery</span>
                  </div>
                  <div className="security-note">
                    <b>No SOC 2 attestation yet.</b>
                    <p>
                      Production SSO/MFA, isolated infrastructure identities,
                      KMS, monitored backups, independent security testing,
                      operating evidence, and a CPA examination remain release
                      gates.
                    </p>
                  </div>
                </aside>
              </div>
            )}
            <footer>
              Prototype only <span>·</span> Fictional customer data{" "}
              <span>·</span> No live AI or external connections
            </footer>
          </>
        )}
      </main>
      <dialog
        ref={dialog}
        onCancel={() => setReviewId(null)}
        onClose={() => setReviewId(null)}
        aria-labelledby="review-title"
      >
        <div className="dialog-content">
          <button
            className="dialog-close"
            aria-label="Close action review"
            onClick={() => setReviewId(null)}
          >
            <X size={21} />
          </button>
          <span className="eyebrow">Human approval</span>
          <h2 id="review-title">Review before it runs.</h2>
          <p>
            An agent prepared this action. Your approval applies only to this
            intent, source version, and permission grant.
          </p>
          {review && snapshot && (
            <>
              <div className="review-summary">
                <b>Create internal follow-up</b>
                <dl>
                  <dt>Workspace</dt>
                  <dd>{snapshot.name}</dd>
                  <dt>Account</dt>
                  <dd>Alpha</dd>
                  <dt>Source</dt>
                  <dd>{review.title}</dd>
                  <dt>Action</dt>
                  <dd>Prepare a follow-up for the engineering team.</dd>
                  <dt>Permission</dt>
                  <dd>followup.create · grant v{review.grant_version}</dd>
                </dl>
                <small>
                  Intent fingerprint{" "}
                  <code>{review.intent_hash.slice(0, 16)}</code>
                </small>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={loseResponse}
                  disabled={busy || review.state === "outcome_unknown"}
                  onChange={(e) => setLoseResponse(e.target.checked)}
                />
                <span>
                  Simulate an interrupted response
                  <small>
                    The fixture accepts the action, but the result must be
                    reconciled.
                  </small>
                </span>
              </label>
              {error && (
                <p className="dialog-error" role="alert">
                  {error}
                </p>
              )}
              <div className="button-row">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setReviewId(null)}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  disabled={busy || !owner}
                  onClick={() =>
                    void act(
                      async () => {
                        if (review.state === "outcome_unknown")
                          await command("reconcile", { id: review.id });
                        else {
                          if (review.state === "waiting_approval")
                            await command("approve", {
                              id: review.id,
                              hash: review.intent_hash,
                            });
                          await command("execute", {
                            id: review.id,
                            loseResponse,
                          });
                        }
                        setReviewId(null);
                      },
                      review.state === "outcome_unknown"
                        ? "The existing receipt was verified without sending another action."
                        : loseResponse
                          ? "Response interrupted. Reconcile the outcome before any retry."
                          : "The follow-up was created and verified in the fictional customer bridge.",
                    )
                  }
                >
                  {busy ? <Loader2 className="spin" size={16} /> : null}
                  {review.state === "outcome_unknown"
                    ? "Reconcile outcome"
                    : "Approve & run"}
                  <ArrowRight size={16} />
                </button>
              </div>
              <p className="small-note">
                This action affects only synthetic data in {snapshot.name}.
              </p>
            </>
          )}
        </div>
      </dialog>
    </div>
  );
}
function ActivityList({
  snapshot,
  compact = false,
}: {
  snapshot: Snapshot;
  compact?: boolean;
}) {
  const events = compact
    ? snapshot.audit.filter((e) => !e.event.startsWith("usage.")).slice(0, 3)
    : snapshot.audit;
  return (
    <ul className="activity-list">
      {events.map((e) => (
        <li key={e.seq}>
          <i className={e.event.startsWith("denied.") ? "off" : ""} />
          <div>
            <span>
              {labels[e.event] ??
                (e.event.startsWith("denied.")
                  ? `Request denied · ${e.event.slice(7).replaceAll("_", " ").toLowerCase()}`
                  : e.event)}
            </span>
            {!compact && (
              <small>
                {e.actor} · #{e.seq} · {e.resource}
              </small>
            )}
          </div>
          <time dateTime={e.at}>
            {new Date(e.at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </li>
      ))}
    </ul>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
