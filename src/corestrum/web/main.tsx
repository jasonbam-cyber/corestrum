import React, {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  UserButton,
  useAuth,
  useUser,
  useReverification,
} from "@clerk/react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Layers3,
  LayoutDashboard,
  Workflow,
  Users,
  Link2,
  ShieldCheck,
  LockKeyhole,
  Download,
  Plus,
  Play,
  Pause,
  Send,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  LogOut,
  Loader2,
  Monitor,
  KeyRound,
  FileText,
  Terminal,
  Menu,
  X,
  BookOpen,
  Sun,
  Moon,
  Sparkles,
} from "lucide-react";
import "@fontsource-variable/inter";
import { AGENTS, PLANS, TEMPLATES, type Plan, type AgentId } from "../catalog";
import { AgentGuide } from "./AgentGuide";
import "./styles.css";
import "./glass.css";
import { Reveal, usePageMotion, useInputModality } from "./motion";
import { WorkspaceInsights } from "./WorkspaceInsights";
type Config = {
  mode: "cloud" | "local";
  edition?: "community" | "licensed";
  environment: string;
  publishableKey?: string;
  checkoutReady?: boolean;
  cloudOrigin?: string;
  downloadUrl?: string;
};
const messages: Record<string, string> = {
  STAGING_CONFIGURATION_PENDING:
    "Staging account and payment setup is still being connected. Purchases are unavailable.",
  SIGN_IN_REQUIRED: "Sign in to your Corestrum account to continue.",
  MFA_ENROLLMENT_REQUIRED:
    "Enable an authenticator in your account security settings, then try again.",
  BILLING_REVIEW_REQUIRED:
    "A payment reversal needs review. Contact product support before purchasing again.",
  MFA_REQUIRED:
    "Enable an authenticator in your account security settings, then verify your identity again.",
  VAULT_UNLOCK_FAILED:
    "The vault could not be unlocked. Check your passphrase and try again.",
  LOCAL_SESSION_REQUIRED:
    "Open the private launch link created when you started Corestrum.",
  SEPARATE_COMMUNITY_VAULT_REQUIRED: "Use a separate empty data folder for the community edition. Your licensed workspace was left unchanged.",
  SEPARATE_LICENSED_VAULT_REQUIRED: "Use a separate data folder for a licensed installation.",
  LICENSE_REQUIRED: "Activate this computer with your Corestrum license first.",
  CLAUDE_NOT_INSTALLED: "Install the official native Claude Code app first. Setup instructions are in Connections.",
  CLAUDE_MAC_REQUIRED: "This preview connection is qualified for macOS only.",
  CLAUDE_VERSION_REQUIRED: "Update Claude Code to version 2.1.296 or later using its official updater.",
  CLAUDE_UNTRUSTED_BINARY: "Corestrum could not verify Anthropic's signed native executable. Reinstall from the official source.",
  CLAUDE_SIGN_IN_REQUIRED: "Sign in through Claude Code using the setup command, then check status again.",
  CLAUDE_PROFILE_NOT_EMPTY: "An account was found before this profile was prepared. Stop and contact support; Corestrum will not use it.",
  CLAUDE_PROFILE_MISMATCH: "Claude's profile does not match this installation. Reconnect through Connections.",
  CLAUDE_ACCOUNT_CHANGED: "The Claude account changed. Check your account in Claude Code and reconnect. No report was saved.",
  CLAUDE_CONFIRM_ACCOUNT: "Confirm that you signed in with your own account before connecting.",
  CLAUDE_PROFILE_NOT_PREPARED: "Prepare the separate Claude profile in Connections first.",
  CLAUDE_CANCELLED: "The local request was stopped. Your provider may already have processed some usage; Corestrum will not retry it.",
  CLAUDE_OUTCOME_UNKNOWN: "Claude did not finish in time. Usage may have occurred. Review your account before trying again.",
  CLAUDE_REQUEST_FAILED: "Claude could not finish this request. Check your sign-in, plan limits and model access in Claude Code before retrying.",
  CLAUDE_INVALID_RESPONSE: "Claude returned an unexpected response. No report was saved. Check Claude Code before retrying.",
  CLAUDE_OUTPUT_LIMIT: "Claude's response exceeded the local safety limit. No report was saved; usage may have occurred.",
  CLAUDE_UNAVAILABLE: "Claude Code could not be started. Check its installation and try again.",
  CLAUDE_TURN_LIMIT: "Claude reached the one-turn report limit. No report was saved. Narrow your request before trying again.",
  BACKUP_PASSPHRASE_LENGTH: "Use a backup passphrase of 16–256 characters and keep it somewhere secure.",
  BACKUP_UNLOCK_FAILED: "The backup could not be unlocked. Check its passphrase and file; nothing was restored.",
  BACKUP_WORKSPACE_MISMATCH: "This backup belongs to another business. Activate the matching Corestrum workspace first.",
  RESTORE_REQUIRES_EMPTY_WORKSPACE: "Restore into an empty workspace with no saved brief, reports, routines or activity. Existing work will not be overwritten.",
  BACKUP_LEDGER_INVALID: "The backup's activity chain failed verification. Nothing was restored.",
  BACKUP_TOO_LARGE: "This backup exceeds the preview's 4 MB business-data limit. Contact support for a larger export.",
  INVALID_BACKUP: "Choose a valid Corestrum encrypted business backup under 6 MB.",
  INVALID_BACKUP_CONTENT: "The backup contains unsupported or damaged business records. Nothing was restored.",
  RESTORE_CONFIRM_REQUIRED: "Confirm the restore instructions before continuing.",
  BACKUP_PASSWORD_MISMATCH: "The backup passphrases do not match. Re-enter them before saving.",
  CUSTOMER_AI_REQUIRED: "Connect your own AI account in Connections first.",
  MODEL_NOT_AVAILABLE:
    "That model is not available to this key. Check the model ID in your provider account.",
  PROVIDER_CREDENTIAL_REJECTED:
    "Your provider rejected this key. No key was saved.",
  DAILY_AI_RUN_LIMIT:
    "You have reached the safety limit of 20 AI runs in 24 hours.",
  VAULT_LOCKED: "Unlock your local vault to continue.",
  LAUNCH_LINK_EXPIRED:
    "This launch link has already been used. Restart Corestrum to create a new one.",
  PAYMENT_REQUIRED: "An active Corestrum license is required for activation.",
  RUN_IN_PROGRESS:
    "Your team is already working on a draft. Wait for it to finish.",
  TRY_AGAIN_LATER: "Please wait a moment before trying the passphrase again.",
};
const friendly = (e: unknown) =>
  messages[(e as Error).message] ??
  "This request could not be completed. Check your connection and setup, then try again.";
function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function Brand() {
  return (
    <a className="brand" href="/">
      <Mark />
      corestrum<span className="brand-dot">.</span>
    </a>
  );
}
function Button({
  children,
  busy,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} disabled={props.disabled || busy}>
      {busy ? <Loader2 size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={"notice " + (error ? "error" : "")}
      role={error ? "alert" : "status"}
    >
      {error ? <AlertCircle size={18} /> : <ShieldCheck size={18} />}
      <span>{children}</span>
    </div>
  );
}
function ThemeButton() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("corestrum-appearance") === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <button className="theme-toggle" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} appearance`} title={`Switch to ${theme === "dark" ? "light" : "dark"} appearance`} onClick={() => {
    const next = theme === "dark" ? "light" : "dark"; setTheme(next);
    try { localStorage.setItem("corestrum-appearance", next); } catch { /* Appearance is optional. */ }
  }}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>;
}
function App() {
  useInputModality();
  const [config, setConfig] = useState<Config | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then(setConfig)
      .catch(() =>
        setError("Corestrum could not connect. Refresh to try again."),
      );
  }, []);
  if (error)
    return (
      <div className="boot">
        <Brand />
        <Notice error>{error}</Notice>
      </div>
    );
  if (!config)
    return (
      <div className="boot">
        <Brand />
        <p>Opening your workspace…</p>
      </div>
    );
  if (config.mode === "local") return <LocalApp config={config} />;
  return config.publishableKey ? (
    <ClerkProvider publishableKey={config.publishableKey}>
      <Cloud config={config} />
    </ClerkProvider>
  ) : (
    <CommunityWelcome />
  );
}
function CommunityWelcome() {
  return <div className="site community-site">
    <header><Brand /><nav><a href="#community-team">The team</a><a href="#community-control">Your workspace</a></nav><div className="button-row"><ThemeButton /><a className="button outline" href="https://github.com/jasonbam-cyber/corestrum">View on GitHub <ArrowUpRight size={16} /></a></div></header>
    <main>
      <section className="community-hero">
        <Reveal><span className="eyebrow"><span className="status-dot" /> FREE. OPEN SOURCE. YOURS.</span><h1>Your business.<br /><em>In concert.</em></h1><p>Six specialist AI roles. One calm place to think, plan and move your SaaS forward. Bring your context. Connect your AI. Make the next move yours.</p><a className="button dark" href="https://github.com/jasonbam-cyber/corestrum#quickstart">Set up your workspace <ArrowRight size={17} /></a><span className="community-license">Apache 2.0 · No Corestrum subscription</span></Reveal>
        <Reveal className="community-orchestra glass-card" delay={80}><span className="eyebrow">A SMALL TEAM. A BIGGER PICTURE.</span><div className="orchestra-center"><Mark /><h2>Clarity starts here.</h2><p>Your context becomes reviewable work.</p></div><div className="orchestra-roles">{AGENTS.map((a, i) => <div key={a.id}><span className={`role-dot role-color-${i}`} />{a.name}<ChevronRight size={14} /></div>)}</div><span className="orchestra-footer"><ShieldCheck size={15} />You review. You decide.</span></Reveal>
      </section>
      <section className="section" id="community-team"><div className="section-head"><div><span className="eyebrow">SPECIALISTS, WORKING TOGETHER</span><h2>A role for every angle.</h2></div><p>Practical perspectives for the decisions ahead. Every response is a draft for your review.</p></div><div className="agent-grid">{AGENTS.map((a, i) => <Reveal className="agent-card glass-card" key={a.id} delay={(i % 3) * 40}><span className={`avatar role-color-${i}`}>{a.initials}</span><h3>{a.name}</h3><p>{a.description}</p><div className="tags">{a.specialties.map(t => <span key={t}>{t}</span>)}</div></Reveal>)}</div></section>
      <section className="section community-control" id="community-control"><Reveal className="glass-card"><LockKeyhole size={28} /><h2>A workspace that stays yours.</h2><p>Your brief, reports and routines live locally. Connect your own AI account; your provider and hosting costs remain yours. Routines start paused, ready for your review.</p><a className="button outline" href="https://github.com/jasonbam-cyber/corestrum#quickstart">Read the quickstart <ArrowUpRight size={16} /></a></Reveal><Reveal className="glass-card" delay={60}><ShieldCheck size={28} /><h2>Clear boundaries. Real ownership.</h2><p>No Corestrum subscription, activation server or purchase is required. Optional connectors use your own infrastructure and need their own setup and qualification.</p><Notice>Source preview. Security controls and evidence tools do not confer SOC 2 attestation.</Notice></Reveal></section>
    </main><footer><Brand /><span>Free, local-first operations for SaaS founders.</span><a href="https://github.com/jasonbam-cyber/corestrum">Apache 2.0 <ArrowUpRight size={12} /></a></footer>
  </div>;
}
function Cloud({ config }: { config: Config }) {
  const [page, setPage] = useState(
    new URLSearchParams(location.search).has("account") ||
      new URLSearchParams(location.search).has("checkout")
      ? "account"
      : "welcome",
  );
  return (
    <div className="site">
      <header>
        <Brand /><ThemeButton />
        <nav>
          <a href="#how">How it works</a>
          <a href="#team">Your team</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <Button
          className="dark"
          onClick={() => setPage(page === "account" ? "welcome" : "account")}
        >
          {page === "account" ? "Back to overview" : "Get started"}
          <ArrowUpRight size={15} />
        </Button>
      </header>
      <div className="staging-strip">
        <span className="status-dot" /> Staging preview{" "}
        <span>Customer setup is being qualified. No live purchases.</span>
      </div>
      {page === "account" ? (
        <section className="account-area">
          <div className="eyebrow">YOUR CORESTRUM ACCOUNT</div>
          <h1>
            A little setup.
            <br />A lot off your plate.
          </h1>
          <p className="lead">
            Manage your access here. Your business data and AI keys stay in your
            local installation.
          </p>
          {config.publishableKey ? (
            <Account config={config} />
          ) : (
            <Notice>
              Clerk has been selected for secure sign-in. The dedicated staging
              application is awaiting setup.
            </Notice>
          )}
        </section>
      ) : (
        <>
          <section className="hero">
            <div>
              <div className="eyebrow">
                <span className="status-dot" /> A SMALL TEAM. A BIGGER PICTURE.
              </div>
              <h1>
                Your business,
                <br />
                <em>in concert.</em>
              </h1>
              <p className="lead">
                Meet the operations team that helps you keep things moving. One
                place for the priorities, follow-through, and evidence behind
                your business.
              </p>
              <div className="hero-actions">
                <Button className="dark" onClick={() => setPage("account")}>
                  Build your team <ArrowRight size={17} />
                </Button>
                <a href="#how">
                  See how it works <ChevronDown size={15} />
                </a>
              </div>
              <div className="hero-points">
                <span>
                  <Monitor size={15} /> Runs on your computer
                </span>
                <span>
                  <KeyRound size={15} /> Your AI. Your account.
                </span>
              </div>
            </div>
            <div className="hero-visual">
              <div className="visual-top">
                <span>
                  <Mark /> YOUR OPERATIONS DESK
                </span>
                <span className="tiny-pill">Illustrative preview</span>
              </div>
              <div className="greeting">
                A clear plan.
                <br />A calmer day.
              </div>
              <div className="lead-card">
                <span className="avatar green">OP</span>
                <div>
                  <strong>Operations Lead</strong>
                  <p>Let’s turn your priorities into a plan.</p>
                </div>
                <span className="online" />
              </div>
              <div className="team-lines">
                {[
                  { a: AGENTS[1], t: "Organize customer questions" },
                  { a: AGENTS[3], t: "Review the numbers" },
                  { a: AGENTS[2], t: "Find the next growth opportunity" },
                ].map(({ a, t }) => (
                  <div className="team-line" key={a.id}>
                    <span className="branch-line" />
                    <span className="avatar small">{a.initials}</span>
                    <div>
                      <strong>{a.name}</strong>
                      <p>{t}</p>
                    </div>
                    <ChevronRight size={16} />
                  </div>
                ))}
              </div>
              <div className="visual-foot">
                <ShieldCheck size={15} /> You set the direction. You keep the
                decisions.
              </div>
            </div>
          </section>
          <section className="how section" id="how">
            <div className="section-intro">
              <span className="eyebrow">YOURS, FROM THE START</span>
              <h2>
                A team that fits
                <br />
                the way you work.
              </h2>
              <p>
                Corestrum coordinates your work without taking ownership of your
                systems.
              </p>
            </div>
            <div className="steps">
              {[
                [
                  "01",
                  "Bring it home",
                  "Install Corestrum on your computer. Your workspace, encrypted credentials and reports live with you.",
                ],
                [
                  "02",
                  "Connect on your terms",
                  "Use your own OpenAI or Anthropic API account. Give each connection only the access it needs.",
                ],
                [
                  "03",
                  "Put your priorities in motion",
                  "Ask your Operations Lead for a plan. Set up repeatable reviews and keep a record of the work.",
                ],
              ].map(([n, t, d]) => (
                <article key={n}>
                  <span>{n}</span>
                  <h3>{t}</h3>
                  <p>{d}</p>
                </article>
              ))}
            </div>
          </section>
          <section className="section team-section" id="team">
            <div className="section-head">
              <div>
                <span className="eyebrow">THE RIGHT ROLE FOR THE WORK</span>
                <h2>Everyone has a purpose.</h2>
              </div>
              <p>
                Functional specialists, coordinated by your Operations Lead. No
                personalities to decode.
              </p>
            </div>
            <div className="agent-grid">
              {AGENTS.map((a, i) => (
                <article className="agent-card" key={a.id}>
                  <span
                    className={
                      `avatar role-color-${i}`
                    }
                  >
                    {a.initials}
                  </span>
                  <h3>{a.name}</h3>
                  <p>{a.description}</p>
                  <div className="tags">
                    {a.specialties.slice(0, 2).map((s) => (
                      <span key={s}>{s}</span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="control-band">
            <ShieldCheck size={32} />
            <div>
              <h2>Useful autonomy. Clear accountability.</h2>
              <p>
                Reviewable drafts, scoped database access and an activity
                ledger. Financial commitments stay with you. Corestrum supports
                audit preparation; it does not provide SOC 2 certification.
              </p>
            </div>
            <span className="tiny-pill">BUILT WITH BOUNDARIES</span>
          </section>
          <section className="section pricing" id="pricing">
            <div className="section-head">
              <div>
                <span className="eyebrow">SMALL OVERHEAD. REAL OWNERSHIP.</span>
                <h2>
                  Software pricing.
                  <br />
                  Without an AI markup.
                </h2>
              </div>
              <p>
                You pay your AI provider directly. Every plan includes the same
                local workspace and agent roles.
              </p>
            </div>
            <div className="price-grid">
              {(Object.entries(PLANS) as [Plan, (typeof PLANS)[Plan]][]).map(
                ([id, p]) => (
                  <article
                    className={
                      "price-card " + (id === "annual" ? "featured" : "")
                    }
                    key={id}
                  >
                    {id === "annual" ? (
                      <span className="price-flag">A good place to start</span>
                    ) : null}
                    <h3>{p.name}</h3>
                    <div className="price">
                      ${p.cents / 100}
                      <span>{p.cadence ? " / " + p.cadence : " once"}</span>
                    </div>
                    <p>{p.description}</p>
                    <ul>
                      <li>
                        <Check size={15} /> Local workspace & agent roles
                      </li>
                      <li>
                        <Check size={15} /> Bring your own AI credentials
                      </li>
                      <li>
                        <Check size={15} /> One business · two computers
                      </li>
                      <li>
                        <Check size={15} /> Export your evidence
                      </li>
                    </ul>
                    <Button
                      className={id === "annual" ? "dark" : "outline"}
                      onClick={() => setPage("account")}
                    >
                      Choose {p.name.toLowerCase()}
                      <ArrowRight size={16} />
                    </Button>
                  </article>
                ),
              )}
            </div>
            <p className="pricing-note">
              AI, database hosting and third-party services are paid separately.
              Subscriptions renew until canceled. Standard support means product
              assistance, not managed business operations. Proposed terms are
              shown for staging review; sales are not open.
            </p>
          </section>
          <section className="closing">
            <span className="eyebrow">LESS CHASING. MORE BUILDING.</span>
            <h2>
              Give your business
              <br />a little more backup.
            </h2>
            <Button className="dark" onClick={() => setPage("account")}>
              Set up Corestrum
              <ArrowRight size={17} />
            </Button>
          </section>
        </>
      )}
      <footer>
        <Brand />
        <span>A standalone product by Bamberg Digital.</span>
        <span>Local first. Customer funded AI.</span>
      </footer>
    </div>
  );
}
function Account({ config }: { config: Config }) {
  const { isSignedIn } = useUser(),
    { getToken } = useAuth();
  const [account, setAccount] = useState<any>(null),
    [identityVerified, setIdentityVerified] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [activation, setActivation] = useState("");
  const request = async (path: string, body?: unknown) => {
    const token = await getToken();
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const d = await r.json();
    if (d.clerk_error) return d;
    if (!r.ok) throw new Error(d.error);
    return d;
  };
  const protectedRequest = useReverification(request);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setIdentityVerified(false);
    if (isSignedIn)
      void act(async () => {
        await request("/api/identity");
        setIdentityVerified(true);
        if (config.checkoutReady) setAccount(await request("/api/account"));
      });
  }, [isSignedIn, config.checkoutReady]);
  if (!isSignedIn)
    return (
      <div className="sign-in">
        {new URLSearchParams(location.search).has("signup") ? (
          <SignUp
            routing="hash"
            signInUrl="/?account=1"
            forceRedirectUrl="/?account=1"
          />
        ) : (
          <SignIn
            routing="hash"
            signUpUrl="/?account=1&signup=1"
            forceRedirectUrl="/?account=1"
          />
        )}
      </div>
    );
  return (
    <div className="account-panel">
      <div className="panel-head">
        <h2>Your Corestrum license</h2>
        <UserButton />
      </div>
      {error ? <Notice error>{error}</Notice> : null}
      {!config.checkoutReady ? (
        <Notice>
          {identityVerified ? "Your sign-in is verified. " : "Your sign-in still needs server verification. "}
          Payment and licensing configuration is pending; no purchase can be made yet.
        </Notice>
      ) : null}
      {account && account.plan !== "complimentary" ? <div className="price-grid compact">
        {(Object.keys(PLANS) as Plan[]).map((p) => (
          <Button
            key={p}
            className="outline"
            busy={busy}
            disabled={!config.checkoutReady || account?.state === "active"}
            onClick={() =>
              void act(async () => {
                const d = await protectedRequest("/api/checkout", { plan: p });
                window.location.assign(d.url);
              })
            }
          >
            {PLANS[p].name} · ${PLANS[p].cents / 100}
          </Button>
        ))}
      </div> : null}
      {account?.state === "active" ? (
        <>
          <Notice>
            {account.plan === "complimentary"
              ? "Your lifetime complimentary access is active. No Corestrum purchase or renewal fee, including future versions. Your AI usage remains on your own account."
              : `Your ${account.plan} license is active.`}
            {" "}Activate your local installation below.
          </Notice>
          {config.downloadUrl ? (
            <a className="button dark" href={config.downloadUrl}>
              <Download size={17} />
              Installation package
            </a>
          ) : (
            <Notice>
              The signed installation package is not published yet.
            </Notice>
          )}
          <label className="field">
            Computer activation request
            <textarea
              value={activation}
              onChange={(e) => setActivation(e.target.value)}
              placeholder="Paste the activation request from your local Corestrum app. It contains a public key, never your AI credentials."
            />
          </label>
          <Button
            className="dark"
            busy={busy}
            onClick={() =>
              void act(async () => {
                const d = await protectedRequest(
                  "/api/license/activate",
                  JSON.parse(activation),
                );
                download("corestrum-license.json", d);
                setActivation("");
              })
            }
          >
            Activate computer
          </Button>
          {account.plan !== "complimentary" ? <Button
            className="outline"
            onClick={() =>
              void act(async () => {
                const d = await protectedRequest("/api/billing/portal", {});
                window.location.assign(d.url);
              })
            }
          >
            Manage subscription
          </Button> : null}
        </>
      ) : null}
      <p className="muted">
        Activation requires recent multi-factor verification. Enable an
        authenticator from your account menu.
      </p>
    </div>
  );
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const nav = [
  { id: "Getting started", icon: BookOpen },
  { id: "Overview", icon: LayoutDashboard },
  { id: "Automations", icon: Workflow },
  { id: "Team", icon: Users },
  { id: "Connections", icon: Link2 },
  { id: "Evidence", icon: ShieldCheck },
];
function LocalApp({ config }: { config: Config }) {
  const [state, setState] = useState<any>(null),
    [page, setPage] = useState("Overview"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [license, setLicense] = useState(""),
    [context, setContext] = useState(""),
    [prompt, setPrompt] = useState(""),
    [teamReview, setTeamReview] = useState(false),
    [routineName, setRoutineName] = useState("Business review"),
    [routineHours, setRoutineHours] = useState(24),
    [agent, setAgent] = useState<AgentId>("operations"),
    [provider, setProvider] = useState("openai"),
    [apiProvider, setApiProvider] = useState("openai"),
    [claudeStatus, setClaudeStatus] = useState<any>(null),
    [claudeCommand, setClaudeCommand] = useState(""),
    [claudeModel, setClaudeModel] = useState("sonnet"),
    [claudeConfirmed, setClaudeConfirmed] = useState(false),
    [result, setResult] = useState(""),
    [key, setKey] = useState(""),
    [model, setModel] = useState(""),
    [project, setProject] = useState(""),
    [accounts, setAccounts] = useState(""),
    [manifest, setManifest] = useState<any>(null),
    [installation, setInstallation] = useState(""),
    [resource, setResource] = useState(""),
    [accountId, setAccountId] = useState(""),
    [menu, setMenu] = useState(false),
    [backupPassword, setBackupPassword] = useState(""),
    [backupConfirmation, setBackupConfirmation] = useState(""),
    [backupArchive, setBackupArchive] = useState(""),
    [backupFilename, setBackupFilename] = useState(""),
    [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const mainRef = React.useRef<HTMLElement>(null);
  const backupFileInput = React.useRef<HTMLInputElement>(null);
  const csrf = React.useRef("");
  const contextDirty = React.useRef(false);
  const initialPageChosen = React.useRef(false);
  const [guideDraft, setGuideDraft] = useState(0);
  useEffect(() => {
    if (guideDraft > 0) document.getElementById("owner-prompt")?.focus();
  }, [guideDraft]);
  useEffect(() => {
    setResult("");
    setError("");
    setNotice("");
    setBackupPassword(""); setBackupConfirmation("");
  }, [page]);
  const request = async (path: string, body?: unknown) => {
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf.current,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    return d;
  };
  const refresh = async () => {
    const d = await request("/api/local/state");
    csrf.current = d.csrf;
    setState(d);
    if (!d.unlocked) {
      contextDirty.current = false;
      setContext(""); setResult(""); setPrompt(""); setKey(""); setPassword("");
      setBackupPassword(""); setBackupConfirmation(""); setBackupArchive(""); setBackupFilename(""); setRestoreConfirmed(false);
      setClaudeStatus(null); setClaudeCommand(""); setClaudeConfirmed(false);
    }
    if (!initialPageChosen.current && d.unlocked && d.license) {
      initialPageChosen.current = true;
      if (!d.operations?.reports?.length) setPage("Getting started");
    }
    if (!contextDirty.current) setContext(d.businessContext ?? "");
  };
  const act = async (fn: () => Promise<void>, message = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void act(async () => {
      const token = new URLSearchParams(location.hash.slice(1)).get("launch");
      if (token) {
        history.replaceState(null, "", location.pathname);
        const d = await request("/api/local/session", { token });
        csrf.current = d.csrf;
      }
    });
  }, []);
  useEffect(() => {
    // GET does not renew server inactivity. Clear the displayed workspace when it locks.
    const timer = setInterval(() => { void refresh().catch(() => {
      setState((previous: any) => previous ? { ...previous, unlocked: false } : previous);
      setContext(""); setResult(""); setPrompt(""); setKey(""); setBackupPassword(""); setBackupConfirmation("");
    }); }, 30000);
    return () => clearInterval(timer);
  }, []);
  const submit = (fn: () => Promise<void>) => (e: FormEvent) => {
    e.preventDefault();
    void act(fn);
  };
  const ready = state?.unlocked && state?.license;
  usePageMotion(mainRef, `${page}:${Boolean(ready)}:${Boolean(state?.unlocked)}`);
  useEffect(() => {
    window.scrollTo(0, 0);
    if (document.documentElement.dataset.input === "keyboard") mainRef.current?.focus({ preventScroll: true });
  }, [page]);
  return (
    <div className="workspace">
      <a className="skip-link" href="#workspace-main">Skip to workspace</a>
      <aside id="workspace-navigation" className={menu ? "expanded" : ""}>
        <Brand />
        <div className="workspace-name">
          <span className="workspace-avatar">C</span>
          <span>
            Your business<small>{config.edition === "community" ? "Free community workspace" : "Local workspace"}</small>
          </span>
          <ChevronDown size={14} />
        </div>
        <span className="nav-caption">YOUR WORKSPACE</span>
        <nav aria-label="Workspace pages">
          <span className="nav-selection" aria-hidden="true" style={{ transform: `translateY(${Math.max(0, nav.findIndex(n => n.id === page)) * 54}px)` }} />
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "selected" : ""}
              aria-current={page === n.id ? "page" : undefined}
              onClick={() => {
                setPage(n.id);
                setMenu(false);
              }}
            >
              <n.icon size={18} />
              {n.id}
              {n.id === "Automations" ? (
                <span className="nav-count">
                  {state?.operations?.automations?.length ?? 0}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div>
            <span className="status-dot" /> Running on this computer
          </div>
          <p>
            Your data stays local.
            <br />
            Your AI usage stays yours.
          </p>
          <button
            disabled={!state?.unlocked}
            onClick={() =>
              void act(async () => {
                await request("/api/local/lock", {});
                setResult("");
              })
            }
          >
            <LockKeyhole size={16} />
            Lock workspace
          </button>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-header">
          <Button
            className="mobile-menu"
            aria-label="Toggle navigation"
            aria-expanded={menu}
            aria-controls="workspace-navigation"
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X /> : <Menu />}
          </Button>
          <span>
            Workspace <ChevronRight size={13} /> {page}
          </span>
          <div>
            <ThemeButton />
            <span className="tiny-pill">
              {config.environment === "staging" ? "STAGING" : "LOCAL"}
            </span>
            <span className="owner-avatar">You</span>
          </div>
        </header>
        <main ref={mainRef} id="workspace-main" tabIndex={-1}>
          {error ? <Notice error>{error}</Notice> : null}
          {notice ? <Notice>{notice}</Notice> : null}
          {!state ? (
            <div className="empty">
              <LockKeyhole />
              <h2>Open your private workspace.</h2>
              <p>
                Use the launch link created by the Corestrum app on this
                computer. The link is single-use and should not be shared.
              </p>
            </div>
          ) : !state.unlocked ? (
            <div className="setup-card">
              <div className="eyebrow">YOUR LOCAL WORKSPACE</div>
              <h1>
                {state.vaultExists ? "Welcome back." : "Make yourself at home."}
              </h1>
              <p>
                Your vault protects AI credentials and private reports with a
                passphrase only you know.
              </p>
              <form
                onSubmit={submit(async () => {
                  const value = password;
                  setPassword("");
                  await request("/api/local/unlock", { password: value });
                })}
              >
                <label className="field">
                  {state.vaultExists
                    ? "Vault passphrase"
                    : "Create a vault passphrase"}
                  <input
                    autoFocus
                    type="password"
                    minLength={14}
                    maxLength={256}
                    autoComplete={
                      state.vaultExists ? "current-password" : "new-password"
                    }
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <p className="muted">
                  At least 14 characters. We cannot recover this passphrase.
                  Keep a secure backup.
                </p>
                <Button className="dark" busy={busy}>
                  <LockKeyhole size={16} />
                  {state.vaultExists
                    ? "Unlock workspace"
                    : "Create encrypted vault"}
                </Button>
              </form>
            </div>
          ) : !state.license ? (
            <div className="setup-card">
              <div className="eyebrow">CONNECT YOUR LICENSE</div>
              <h1>
                One account.
                <br />
                Your own workspace.
              </h1>
              <p>
                Sign in and check your paid or complimentary access at your Corestrum account, then
                activate this computer. No business data or AI keys are
                included.
              </p>
              <a
                className="button outline"
                href={config.cloudOrigin}
                target="_blank"
                rel="noreferrer"
              >
                Open Corestrum account
                <ArrowUpRight size={16} />
              </a>
              <Button
                className="outline"
                busy={busy}
                onClick={() =>
                  void act(async () => {
                    const d = await request("/api/local/activation", {});
                    setResult(JSON.stringify(d));
                  })
                }
              >
                Create activation request
              </Button>
              <Button
                className="outline"
                busy={busy}
                onClick={() =>
                  void act(async () => {
                    await request("/api/local/license/refresh", {});
                  }, "License refreshed.")
                }
              >
                Refresh an existing subscription
              </Button>
              {result ? (
                <label className="field">
                  Public activation request · valid for 60 seconds
                  <textarea readOnly value={result} />
                </label>
              ) : null}
              <form
                onSubmit={submit(async () => {
                  const value = license;
                  setLicense("");
                  await request("/api/local/license", JSON.parse(value));
                  setResult("");
                })}
              >
                <label className="field">
                  License file contents
                  <textarea
                    required
                    value={license}
                    onChange={(e) => setLicense(e.target.value)}
                    placeholder="Paste your downloaded Corestrum license JSON"
                  />
                </label>
                <Button className="dark" busy={busy}>
                  Activate this computer
                  <ArrowRight size={16} />
                </Button>
              </form>
            </div>
          ) : (
            <>
              <div className="page-title"><span className="page-orbit" aria-hidden="true"><Sparkles size={24} /></span>
                <div>
                  <span className="eyebrow">
                    {page === "Overview"
                      ? "A CLEARER PICTURE"
                      : page === "Automations"
                        ? "TURN INTENT INTO FOLLOW-THROUGH"
                        : "YOUR BUSINESS, IN CONCERT"}
                  </span>
                  <h1>
                    {page === "Getting started"
                      ? "Learn to work with your team."
                      : page === "Overview"
                      ? "Your operations desk."
                      : page === "Automations"
                        ? "Put good work on repeat."
                        : page === "Team"
                          ? "Meet your team."
                          : page === "Connections"
                            ? "Connected. On your terms."
                            : "A record you can follow."}
                  </h1>
                  <p>
                    {page === "Getting started"
                      ? "Meet each role, try a practice request and build a routine you understand. Go at your own pace."
                      : page === "Automations"
                      ? "Tell your Operations Lead what matters. Build a routine, review the results, and stay in control."
                      : page === "Connections"
                        ? "API keys are encrypted in your vault. Claude Code manages its own credentials. Neither goes to Corestrum’s servers."
                        : page === "Evidence"
                          ? "Trace configuration changes and agent runs. Export evidence for independent safekeeping."
                          : "One place for the work, the people behind it, and the decisions ahead."}
                  </p>
                </div>
              </div>
              {page === "Overview" || page === "Evidence" ? <WorkspaceInsights
                reports={state.operations?.reports} routines={state.operations?.automations}
                ledgerIntact={state.operations?.ledgerIntact} onNavigate={setPage} compact={page === "Evidence"}
              /> : null}
              {page === "Getting started" ? (
                <AgentGuide
                  hasDraft={Boolean(prompt.trim())}
                  onNavigate={setPage}
                  onPrepareDraft={(role, example) => {
                    setAgent(role);
                    setPrompt(example);
                    setTeamReview(false);
                    setPage("Overview");
                    setGuideDraft((n) => n + 1);
                  }}
                />
              ) : null}
              {page === "Overview" || page === "Automations" ? (
                <>
                  <div className="desk-grid">
                    <section className="conversation panel">
                      <div className="panel-head">
                        <span className="avatar green">
                          {AGENTS.find((a) => a.id === agent)?.initials}
                        </span>
                        <div>
                          <h3>{AGENTS.find((a) => a.id === agent)?.name}</h3>
                          <p>
                            Business planning · recommendations · reviewable
                            drafts
                          </p>
                        </div>
                      </div>
                      <div className="conversation-intro">
                        <h2>What would you like to move forward?</h2>
                        <p>
                          I can help you organize the day, examine the numbers,
                          or find your next growth opportunity. Tell me about
                          the business and we’ll work from there.
                        </p>
                        <div className="suggestions">
                          {[
                            "Help me plan my week",
                            "Review our profit margins",
                            "Plan a customer follow-up workflow",
                          ].map((s) => (
                            <button key={s} onClick={() => setPrompt(s)}>
                              {s}
                              <ArrowUpRight size={13} />
                            </button>
                          ))}
                        </div>
                      </div>
                      {result ? (
                        <div className="draft-result">
                          <span className="tiny-pill">
                            DRAFT · OWNER REVIEW
                          </span>
                          <p>{result}</p>
                        </div>
                      ) : null}
                      <form
                        className="composer"
                        onSubmit={submit(async () => {
                          const d = await request("/api/local/draft", {
                            agent,
                            provider,
                            prompt,
                            specialists:
                              agent === "operations" && teamReview
                                ? ["support", "bookkeeping", "marketing"]
                                : [],
                          });
                          setResult(d.draft.text);
                          setPrompt("");
                        })}
                      >
                        <label className="sr-only" htmlFor="owner-prompt">
                          Message your agent
                        </label>
                        <textarea
                          id="owner-prompt"
                          value={prompt}
                          onChange={(e) => setPrompt(e.target.value)}
                          required
                          maxLength={6000}
                          placeholder="Tell your team what you need…"
                        />
                        <div>
                          <label>
                            <span className="sr-only">Agent role</span>
                            <select
                              value={agent}
                              onChange={(e) =>
                                setAgent(e.target.value as AgentId)
                              }
                            >
                              {AGENTS.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span className="sr-only">AI provider</span>
                            <select
                              value={provider}
                              onChange={(e) => setProvider(e.target.value)}
                            >
                              <option value="openai">Your OpenAI</option>
                              <option value="anthropic">Your Anthropic API</option>
                              <option value="claude-code">Your local Claude Code</option>
                            </select>
                          </label>
                          <Button
                            className="dark icon-button"
                            aria-label="Send to agent"
                            busy={busy}
                          >
                            <ArrowRight size={19} />
                          </Button>
                          {busy && provider === "claude-code" ? <Button type="button" onClick={() => {
                            void request("/api/local/claude/cancel", {}).then(() => setNotice("Stop requested. Provider usage may already have occurred.")).catch((e) => setError(friendly(e)));
                          }}>Stop request</Button> : null}
                        </div>
                        {agent === "operations" ? (
                          <label className="team-review">
                            <input
                              type="checkbox"
                              checked={teamReview}
                              onChange={(e) => setTeamReview(e.target.checked)}
                            />{" "}
                            Include Support, Bookkeeping and Marketing (4 AI
                            requests)
                          </label>
                        ) : null}
                        <small>
                          Uses your AI account. Drafts only; no payments or
                          external actions.
                        </small>
                      </form>
                    </section>
                    <section className="context-panel panel">
                      <span className="eyebrow">THE CONTEXT THAT COUNTS</span>
                      <h3>Tell us about your business.</h3>
                      <p>
                        This is the shared brief your team uses. Include goals
                        and operating preferences. Leave out passwords, customer
                        identities and bank details.
                      </p>
                      <form
                        onSubmit={submit(async () => {
                          await request("/api/local/context", { context });
                          contextDirty.current = false;
                        })}
                      >
                        <label className="field">
                          Business brief
                          <textarea
                            value={context}
                            onChange={(e) => {
                              contextDirty.current = true;
                              setContext(e.target.value);
                            }}
                            maxLength={12000}
                            placeholder="We run a SaaS for small teams. Our priorities are smooth onboarding, useful support, and clear weekly reporting…"
                          />
                        </label>
                        <Button className="outline" busy={busy}>
                          Save business brief
                          <Check size={15} />
                        </Button>
                      </form>
                      <div className="rule-note">
                        <ShieldCheck size={19} />
                        <p>
                          Your team can analyze and recommend. Spending and
                          financial decisions stay with you.
                        </p>
                      </div>
                    </section>
                  </div>
                  <div className="section-head local-section">
                    <div>
                      <h2>
                        {page === "Automations"
                          ? "Your routines"
                          : "Keep things moving"}
                      </h2>
                      <p>
                        Operations Lead routines use up to four AI requests per
                        run. Automations run while this app is open and your
                        vault is unlocked. They pause when the vault locks.
                      </p>
                    </div>
                  </div>
                  {page === "Automations" ? (
                    <section className="panel">
                      <h3>Turn your request into a routine</h3>
                      <p>
                        Use the request in the conversation box above. A
                        scheduled business review asks three specialists, then
                        the Operations Lead prepares your report: up to four
                        requests charged by your AI provider.
                      </p>
                      <form
                        onSubmit={submit(async () => {
                          await request("/api/local/automations", {
                            template: "custom-workflow",
                            instruction: prompt,
                            name: routineName,
                            hours: routineHours,
                            provider,
                          });
                        })}
                      >
                        <label className="field">
                          Routine name
                          <input
                            required
                            maxLength={80}
                            value={routineName}
                            onChange={(e) => setRoutineName(e.target.value)}
                          />
                        </label>
                        <label className="field">
                          Repeat every (hours)
                          <input
                            type="number"
                            required
                            min={1}
                            max={720}
                            value={routineHours}
                            onChange={(e) =>
                              setRoutineHours(Number(e.target.value))
                            }
                          />
                        </label>
                        <Button
                          className="outline"
                          busy={busy}
                          disabled={!prompt.trim()}
                        >
                          Save paused routine
                        </Button>
                      </form>
                    </section>
                  ) : null}
                  <div className="routine-list">
                    {state.operations?.automations?.map((a: any) => (
                      <article key={a.id}>
                        <span className="routine-icon">
                          <Workflow size={19} />
                        </span>
                        <div>
                          <h3>{a.name}</h3>
                          <p>
                            Every {a.hours} hours · {a.provider} ·{" "}
                            {a.enabled ? "Enabled" : "Paused"}
                          </p>
                        </div>
                        <Button
                          className="outline"
                          busy={busy}
                          onClick={() =>
                            void act(async () => {
                              await request("/api/local/automations/toggle", {
                                id: a.id,
                                enabled: !a.enabled,
                              });
                            })
                          }
                        >
                          {a.enabled ? <Pause size={15} /> : <Play size={15} />}{" "}
                          {a.enabled ? "Pause" : "Enable"}
                        </Button>
                      </article>
                    ))}
                  </div>
                  <div className="template-grid">
                    {TEMPLATES.filter((t) => t.id !== "custom-workflow").map(
                      (t) => (
                        <button
                          className="template-card"
                          key={t.id}
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await request("/api/local/automations", {
                                template: t.id,
                                provider,
                                instruction: prompt,
                              });
                            }, "Routine created in a paused state. Enable it when you’re ready.")
                          }
                        >
                          <Workflow size={19} />
                          <strong>{t.name}</strong>
                          <span>
                            {t.hours === 24 ? "Daily" : "Weekly"} ·{" "}
                            {AGENTS.find((a) => a.id === t.agent)?.name}
                          </span>
                          <Plus size={17} />
                        </button>
                      ),
                    )}
                  </div>
                </>
              ) : null}
              {page === "Team" ? (
                <div className="agent-grid">
                  {AGENTS.map((a, i) => (
                    <article className="agent-card" key={a.id}>
                      <span
                        className={
                          `avatar role-color-${i}`
                        }
                      >
                        {a.initials}
                      </span>
                      <h3>{a.name}</h3>
                      <p>{a.description}</p>
                      <div className="tags">
                        {a.specialties.map((s) => (
                          <span key={s}>{s}</span>
                        ))}
                      </div>
                      <Button
                        className="outline"
                        onClick={() => {
                          setAgent(a.id);
                          setPage("Overview");
                        }}
                      >
                        Work with {a.name}
                        <ArrowRight size={14} />
                      </Button>
                    </article>
                  ))}
                </div>
              ) : null}
              {page === "Connections" ? (
                <div className="connection-grid">
                  <section className="panel">
                    <div className="panel-head">
                      <KeyRound />
                      <div>
                        <h3>Your AI account</h3>
                        <p>
                          You pay your provider directly. Corestrum adds no
                          usage markup.
                        </p>
                      </div>
                    </div>
                    <form
                      onSubmit={submit(async () => {
                        const value = key;
                        setKey("");
                        await request("/api/local/provider", {
                          provider: apiProvider,
                          key: value,
                          model,
                        });
                      })}
                    >
                      <label className="field">
                        Provider
                        <select
                          value={apiProvider}
                          onChange={(e) => setApiProvider(e.target.value)}
                        >
                          <option value="openai">OpenAI API</option>
                          <option value="anthropic">Anthropic API</option>
                        </select>
                      </label>
                      <label className="field">
                        Model ID
                        <input
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          required
                          placeholder="A model available in your provider account"
                        />
                      </label>
                      <label className="field">
                        API key
                        <input
                          type="password"
                          value={key}
                          onChange={(e) => setKey(e.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          required
                          minLength={20}
                        />
                      </label>
                      <p className="muted">
                        Masked input, no reveal button. The key is encrypted in
                        your local vault and sent only to your selected
                        provider. Validation does not generate AI content.
                      </p>
                      <Button className="dark" busy={busy}>
                        <LockKeyhole size={16} />
                        Validate & save securely
                      </Button>
                    </form>
                    {state.providers.map((p: any) => (
                      <div className="provider-status" key={p.provider}>
                        <span>
                          {p.provider} ·{" "}
                          {p.connected ? (p.provider === "claude-code" ? "Connection saved; check sign-in below" : "Connected") : "Not connected"}
                        </span>
                        {p.connected ? (
                          <Button
                            aria-label={`Disconnect ${p.provider}`}
                            className="text-button"
                            onClick={() =>
                              void act(async () => {
                                await request(
                                  "/api/local/provider/disconnect",
                                  { provider: p.provider },
                                );
                                if (p.provider === "claude-code") { setClaudeStatus(null); setClaudeConfirmed(false); }
                              })
                            }
                          >
                            Disconnect
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    <Notice>
                      API keys stay encrypted in your local vault. For your Claude subscription, use the separate local connection below. Codex sign-in is not yet available.
                    </Notice>
                  </section>
                  <section className="panel" aria-labelledby="local-claude-heading">
                    <div className="panel-head"><KeyRound /><div>
                      <h3 id="local-claude-heading">Use your local Claude Code</h3>
                      <p>Sign in through Anthropic's unmodified app. Your own plan or provider pays for usage, subject to its limits.</p>
                    </div></div>
                    <ol className="claude-steps">
                      <li>Install the official native macOS version from code.claude.com/docs/en/setup. Version 2.1.296 or later is required.</li>
                      <li>Prepare a separate profile below, then copy the command into Terminal. Complete Claude Code's own setup and sign-in. Choose any authentication option it offers. Enter credentials only in its official flow.</li>
                      <li>Exit Claude Code, return here and check sign-in. Confirm the account is yours, then connect.</li>
                    </ol>
                    <Button busy={busy} type="button" onClick={() => void act(async () => {
                      const d = await request("/api/local/claude/setup", {});
                      setClaudeCommand(d.command); setClaudeConfirmed(false);
                      setClaudeStatus(await request("/api/local/claude/status", {}));
                    })}>Prepare separate profile</Button>
                    {claudeCommand ? <label className="field">Setup command — contains no credentials
                      <textarea readOnly value={claudeCommand} rows={5} spellCheck={false} onFocus={(e) => e.currentTarget.select()} />
                    </label> : null}
                    <Button busy={busy} type="button" onClick={() => void act(async () => {
                      setClaudeStatus(await request("/api/local/claude/status", {})); setClaudeConfirmed(false);
                    })}>Check sign-in</Button>
                    <p role="status">{claudeStatus ? `Claude Code ${claudeStatus.version}: ${claudeStatus.signedIn ? "signed in" : "signed out"}${claudeStatus.connected ? ", connected" : ""}` : "Not checked yet. Checking does not request AI content."}</p>
                    <form onSubmit={submit(async () => {
                      await request("/api/local/claude/connect", { model: claudeModel, confirmed: claudeConfirmed });
                      setClaudeStatus(await request("/api/local/claude/status", {})); setProvider("claude-code");
                    })}>
                      <label className="field">Claude model or alias
                        <input required value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} placeholder="sonnet" />
                      </label>
                      <label className="claude-confirm"><input type="checkbox" checked={claudeConfirmed} onChange={(e) => setClaudeConfirmed(e.target.checked)} /> I completed sign-in with my own account and understand my plan's usage limits.</label>
                      <Button className="dark" busy={busy} disabled={!claudeStatus?.signedIn || !claudeConfirmed}>Connect local account</Button>
                    </form>
                    <Notice>Corestrum does not receive your subscription tokens. Reports use only your supplied brief and request; tools, browser control and MCP access are disabled. Disconnect stops Corestrum's use but does not sign you out of Claude Code. Use /logout in the same separate profile to sign out.</Notice>
                  </section>
                  <section className="panel">
                    <div className="panel-head">
                      <Link2 />
                      <div>
                        <h3>Supabase</h3>
                        <p>
                          Read approved records through a customer-owned bridge.
                        </p>
                      </div>
                    </div>
                    <form
                      onSubmit={submit(async () => {
                        const d = await request("/api/local/supabase/prepare", {
                          project,
                          accounts: accounts.split(/[\s,]+/).filter(Boolean),
                        });
                        setManifest(d);
                        setInstallation(d.installation);
                      })}
                    >
                      <label className="field">
                        Project reference
                        <input
                          value={project}
                          onChange={(e) => setProject(e.target.value)}
                          pattern="[a-z]{20}"
                          required
                          placeholder="Your 20-letter Supabase project reference"
                        />
                      </label>
                      <label className="field">
                        Approved account IDs
                        <textarea
                          value={accounts}
                          onChange={(e) => setAccounts(e.target.value)}
                          required
                          placeholder="One account UUID per line"
                        />
                      </label>
                      <Button className="outline" busy={busy}>
                        Prepare restricted connection
                        <ArrowRight size={16} />
                      </Button>
                    </form>
                    {manifest ? (
                      <>
                        <Notice>
                          Install the bridge in your own project and apply this
                          public grant. No administrator key is required in
                          Corestrum.
                        </Notice>
                        <Button
                          className="outline"
                          onClick={() =>
                            download("corestrum-bridge-grant.json", manifest)
                          }
                        >
                          <Download size={15} />
                          Download public grant
                        </Button>
                      </>
                    ) : null}
                    <label className="field">
                      Installation ID
                      <input
                        value={installation}
                        onChange={(e) => setInstallation(e.target.value)}
                      />
                    </label>
                    <div className="button-row">
                      <Button
                        className="dark"
                        busy={busy}
                        disabled={!installation}
                        onClick={() =>
                          void act(async () => {
                            await request("/api/local/supabase/verify", {
                              installation,
                            });
                          }, "The restricted connection was verified.")
                        }
                      >
                        Verify connection
                      </Button>
                      <Button
                        className="outline"
                        disabled={!installation}
                        onClick={() =>
                          void act(async () => {
                            await request("/api/local/supabase/revoke", {
                              installation,
                            });
                          }, "Local access revoked. Deactivate the grant in Supabase to revoke already-issued requests immediately.")
                        }
                      >
                        Disconnect
                      </Button>
                    </div>
                    <details>
                      <summary>Test an approved record</summary>
                      <label className="field">
                        Account UUID
                        <input
                          value={accountId}
                          onChange={(e) => setAccountId(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        Record UUID
                        <input
                          value={resource}
                          onChange={(e) => setResource(e.target.value)}
                        />
                      </label>
                      <Button
                        className="outline"
                        onClick={() =>
                          void act(async () => {
                            const d = await request(
                              "/api/local/supabase/read",
                              { installation, account: accountId, resource },
                            );
                            setResult(JSON.stringify(d, null, 2));
                          })
                        }
                      >
                        Read approved record
                      </Button>
                      {result ? <pre>{result}</pre> : null}
                    </details>
                  </section>
                </div>
              ) : null}
              {page === "Evidence" ? (
                <>
                  <section className="panel evidence-summary">
                    <ShieldCheck size={28} />
                    <div>
                      <h2>
                        {state.operations?.ledgerIntact
                          ? "Your activity chain is intact."
                          : "Your activity chain needs review."}
                      </h2>
                      <p>
                        Configuration and run receipts are recorded locally.
                        Independent exports help detect replacement or tampering
                        by a local administrator.
                      </p>
                    </div>
                    <Button
                      className="dark"
                      onClick={() =>
                        void act(async () => {
                          download(
                            "corestrum-evidence.json",
                            await request("/api/local/evidence", {}),
                          );
                        })
                      }
                    >
                      <Download size={16} />
                      Export evidence
                    </Button>
                  </section>
                  <section className="panel backup-panel" aria-labelledby="backup-heading">
                    <h2 id="backup-heading">Keep an encrypted business backup</h2>
                    <p>Your business brief, reports, routines and activity history travel together. Stored AI credentials, Claude profiles, licenses, device keys and database connections stay out of this file.</p>
                    <label className="field">Backup passphrase
                      <input type="password" autoComplete="off" spellCheck={false} minLength={16} maxLength={256} value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} />
                    </label>
                    <label className="field">Confirm passphrase for a new backup
                      <input type="password" autoComplete="off" spellCheck={false} maxLength={256} value={backupConfirmation} onChange={(e) => setBackupConfirmation(e.target.value)} />
                    </label>
                    <p className="muted">Use 16 or more characters. Keep the passphrase separately in your password manager; we cannot recover it. Save the file somewhere independent of this Mac.</p>
                    <Button className="dark" type="button" busy={busy} disabled={backupPassword.length < 16} onClick={() => void act(async () => {
                      if (backupPassword !== backupConfirmation) throw Error("BACKUP_PASSWORD_MISMATCH");
                      const password = backupPassword; setBackupPassword(""); setBackupConfirmation("");
                      const archive = await request("/api/local/backup/export", { password });
                      download("corestrum-business-backup.json", archive);
                    }, "Encrypted backup prepared. Complete the save dialog and verify the file exists.")}><Download size={16} />Save encrypted backup</Button>
                    <details>
                      <summary>Restore on a fresh installation</summary>
                      <p>{config.edition === "community" ? "Create an empty community vault, then import your encrypted backup using its passphrase. The data is resealed for this installation; no remote account is needed." : "Activate the same business account on this computer first, then restore before adding a brief or connections."} Existing work is never overwritten. Every restored routine stays paused; reconnect your own AI and business services afterwards.</p>
                      <label className="field">Encrypted backup file
                        <input ref={backupFileInput} type="file" accept="application/json,.json" onChange={async (e) => {
                          const file = e.target.files?.[0]; setBackupArchive(""); setBackupFilename(""); setRestoreConfirmed(false);
                          if (!file) return;
                          try {
                            if (file.size > 6 * 1024 * 1024) throw Error("INVALID_BACKUP");
                            const content = await file.text(); setBackupArchive(content); setBackupFilename(file.name);
                          } catch (error) { setError(friendly(error)); }
                        }} />
                      </label>
                      {backupFilename ? <p>Selected: {backupFilename}. Enter its original passphrase above.</p> : null}
                      <label className="claude-confirm"><input type="checkbox" checked={restoreConfirmed} onChange={(e) => setRestoreConfirmed(e.target.checked)} /> I am restoring this business into its empty workspace and will reconnect services before enabling routines.</label>
                      <Button className="outline" type="button" busy={busy} disabled={!backupArchive || backupPassword.length < 16 || !restoreConfirmed} onClick={() => void act(async () => {
                        const password = backupPassword; setBackupPassword(""); setBackupConfirmation("");
                        const result = await request("/api/local/backup/restore", { password, archive: backupArchive, confirmed: restoreConfirmed });
                        setBackupArchive(""); setBackupFilename(""); setRestoreConfirmed(false); contextDirty.current = false;
                        if (backupFileInput.current) backupFileInput.current.value = "";
                        setResult(`Restored ${result.reports} reports and ${result.routines} paused routines. Reconnect your services before running agents.`);
                      }, "Business data restored. All routines are paused.")}>Restore business data</Button>
                    </details>
                    <Notice>This business backup does not restore your app activation or third-party accounts. A local activity chain and its backup do not constitute independent audit attestation.</Notice>
                  </section>
                  <h2 className="local-section">Recent agent work</h2>
                  <div className="routine-list">
                    {state.operations?.reports?.length ? (
                      state.operations.reports.map((r: any) => (
                        <article key={r.id}>
                          <FileText size={19} />
                          <div>
                            <h3>
                              {AGENTS.find((a) => a.id === r.agent)?.name}
                            </h3>
                            <p>
                              {new Date(r.started).toLocaleString()} ·{" "}
                              {r.state.replaceAll("_", " ")}
                            </p>
                          </div>
                          <Button
                            className="outline"
                            disabled={r.state !== "draft_ready"}
                            onClick={() =>
                              void act(async () => {
                                const d = await request("/api/local/report", {
                                  id: r.id,
                                });
                                setResult(d.text);
                              })
                            }
                          >
                            Read draft
                          </Button>
                        </article>
                      ))
                    ) : (
                      <div className="empty">
                        <FileText />
                        <h3>A clean start.</h3>
                        <p>
                          Your first agent run will appear here with its
                          outcome.
                        </p>
                      </div>
                    )}
                  </div>
                  {result ? (
                    <div className="draft-result">
                      <p>{result}</p>
                    </div>
                  ) : null}
                  <Notice>
                    Corestrum helps organize evidence. SOC 2 also requires
                    organizational controls, an auditor, and evidence that
                    controls operate over time.
                  </Notice>
                </>
              ) : null}
            </>
          )}
        </main>
        <footer className="workspace-footer">
          <span>
            <ShieldCheck size={14} /> Owner decisions stay with you.
          </span>
          <span>
            Corestrum {state?.license?.plan ? "· " + state.license.plan : ""}
          </span>
        </footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
