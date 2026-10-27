import React, { useRef, useState } from "react";
import { ArrowRight, ArrowLeft, Users, FileText, MessageSquareText, ListChecks, Repeat2, ShieldCheck, ChevronRight } from "lucide-react";
import { AGENTS, type AgentId } from "../catalog";
import { Reveal } from "./motion";
import "./agent-guide.css";

const lessons: Record<AgentId, {
  useWhen: string;
  prompt: string;
  review: string;
  limit: string;
}> = {
  operations: {
    useWhen: "Start here when you have a business goal or need several specialists to work together.",
    prompt: "Practice with fictional data only: my SaaS has 8 trial accounts this week, 2 unanswered support tickets and one afternoon reserved for onboarding improvements. Help me plan the week. Give me three priorities, questions about missing information and decisions I need to make. Do not treat this as my real schedule.",
    review: "A short priority list, suggested owners, missing information and decisions for you. Check that the plan fits your actual capacity.",
    limit: "Coordinates advice. Does not deploy your app or make financial decisions.",
  },
  support: {
    useWhen: "You need help answering an inquiry, triaging an onboarding problem or spotting recurring customer questions.",
    prompt: "Practice with a fictional inquiry: a trial user asks whether our SaaS supports a particular integration and what the paid plan costs. Draft a warm reply asking for the minimum information needed. We have not checked the integration or current pricing. Do not promise a feature, quote a fee or send the reply.",
    review: "A reply draft and the facts you must check before sending it. Confirm feature availability and pricing in your actual systems.",
    limit: "Drafts replies. Does not send messages, change subscriptions or issue refunds.",
  },
  marketing: {
    useWhen: "You want a clearer offer, useful content or a small, measurable growth experiment.",
    prompt: "Practice for a fictional SaaS product: suggest a one-week organic referral experiment and draft a short introduction for prospective teams. We have no campaign results yet. Include the audience, message, success measure and assumptions. Do not promise results, publish anything or spend money.",
    review: "A proposed experiment and draft copy. Check the claims, audience and how you will measure success.",
    limit: "Plans and drafts. Does not publish content, launch Meta ads or set budgets.",
  },
  bookkeeping: {
    useWhen: "You have financial summaries to explain, expenses to review or reconciliation differences to investigate.",
    prompt: "Practice with fictional weekly USD cash figures: collected subscription revenue $1,000, hosting costs $120 and payment processing fees $30. Explain what remains after these listed costs and what is missing before we could call it net profit. Show your arithmetic. Do not change any books or make financial decisions.",
    review: "Visible arithmetic, reporting period, assumptions and exceptions. Compare every amount with your source records.",
    limit: "Reviews supplied records. No bank or QuickBooks connection is included today; it cannot move money or post accounting entries.",
  },
  legal: {
    useWhen: "You need to organize obligations or prepare focused questions for a qualified adviser.",
    prompt: "Practice with fictional information: my SaaS wants a process for tracking its supplied vendor contract renewal dates and data-processing agreement review dates. Suggest a simple tracking checklist and questions for a qualified adviser. No jurisdiction or actual dates have been supplied. Do not invent requirements or determine legal validity.",
    review: "A checklist of supplied obligations, missing facts and adviser questions. Verify deadlines and requirements with authoritative sources and your adviser.",
    limit: "Organizes review material. Does not determine contract validity, provide a legal determination, sign or file documents.",
  },
  compliance: {
    useWhen: "You want to organize evidence, review access or identify a gap in a business control.",
    prompt: "Practice with a fictional business: its owner uses MFA but has not tested restoring a backup. Prepare a small evidence checklist covering access, backups and approvals. Separate what is claimed from what has actually been tested. Do not claim that the business is SOC 2 compliant.",
    review: "A control/evidence checklist with owners, gaps and next checks. A configured setting is not proof it worked over time.",
    limit: "Supports audit preparation. Does not certify compliance or replace an independent examination.",
  },
};

const steps = ["Meet your team", "Brief your team", "Try a request", "Review the result", "Set a routine"];
const stepDetails = [
  { icon: Users, detail: "Find the right specialist" },
  { icon: FileText, detail: "Give your work context" },
  { icon: MessageSquareText, detail: "Start with a practice prompt" },
  { icon: ListChecks, detail: "Keep the decisions with you" },
  { icon: Repeat2, detail: "Build a rhythm that works" },
];
type Destination = "Overview" | "Connections" | "Automations" | "Evidence";

/** Training only. Navigating or preparing a prompt never runs AI or enables a routine. */
export function AgentGuide({ onNavigate, onPrepareDraft, hasDraft }: {
  onNavigate: (page: Destination) => void;
  onPrepareDraft: (agent: AgentId, prompt: string) => void;
  hasDraft: boolean;
}) {
  const [step, setStep] = useState(0);
  const [agent, setAgent] = useState<AgentId>("operations");
  const heading = useRef<HTMLHeadingElement>(null);
  const role = AGENTS.find((a) => a.id === agent)!;
  const lesson = lessons[agent];
  const StepIcon = stepDetails[step].icon;
  const move = (next: number) => {
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  };
  return (
    <div className="agent-guide">
      <div className="guide-journey glass-card">
        <div className="guide-journey-heading">
          <span className="eyebrow">A LITTLE GUIDANCE</span>
          <h2>Your first<br />good workflow.</h2>
          <p>Get to know your team, shape a request and make the result your own.</p>
        </div>
        <nav aria-label="Agent guide steps" className="guide-steps">
          {steps.map((title, i) => {
            const Icon = stepDetails[i].icon;
            return <button type="button" key={title} aria-current={i === step ? "step" : undefined} onClick={() => move(i)}>
              <span className="guide-step-symbol" aria-hidden="true"><Icon size={18} /></span>
              <span className="guide-step-copy"><strong>{title}</strong><small>{stepDetails[i].detail}</small></span>
              <span className="guide-step-number" aria-hidden="true">0{i + 1}</span>
            </button>;
          })}
        </nav>
        <div className="guide-boundary"><ShieldCheck size={18} aria-hidden="true" /><p>You stay in control.<br /><span>Explore freely. Nothing runs just from reading this guide.</span></p></div>
      </div>
      <Reveal className="guide-lesson-wrap" delay={60}>
      <section className="panel guide-lesson glass-card" aria-labelledby="guide-heading">
        <div className="guide-lesson-top"><span className="guide-lesson-symbol"><StepIcon size={24} aria-hidden="true" /></span><span className="eyebrow">STEP {step + 1} OF {steps.length}</span><div className="guide-position" aria-hidden="true">{steps.map((title, i) => <span key={title} className={i === step ? "current" : ""} />)}</div></div>
        <h2 id="guide-heading" ref={heading} tabIndex={-1}>{steps[step]}</h2>
        {step === 0 ? <>
          <p>Start with Operations Lead for a business-wide question, or choose a specialist for a focused task. These six roles share the business brief you save for this workspace.</p>
          <div className="guide-role-picker" role="group" aria-label="Explore an agent">
            {AGENTS.map((a) => <button type="button" className="outline guide-role-option" key={a.id} aria-pressed={agent === a.id} onClick={() => setAgent(a.id)}><span className="guide-role-initials" aria-hidden="true">{a.initials}</span><span>{a.name}</span><ChevronRight size={14} aria-hidden="true" /></button>)}
          </div>
          <article className="guide-role" aria-live="polite" aria-atomic="true">
            <div className="guide-role-heading"><span className="guide-role-orbit" aria-hidden="true">{role.initials}</span><div><span className="eyebrow">YOUR SPECIALIST</span><h3>{role.name}</h3></div></div>
            <p>{lesson.useWhen}</p>
            <dl>
              <dt>What to expect</dt><dd>{lesson.review}</dd>
              <dt>What stays with you</dt><dd>{lesson.limit}</dd>
            </dl>
            <button type="button" className="outline" onClick={() => move(2)}>Practice with {role.name}<ArrowRight size={16} /></button>
          </article>
          <p>Operations Lead can include Support, Bookkeeping and Marketing in a team review. You can ask Legal and Compliance directly using the agent selector.</p>
        </> : null}
        {step === 1 ? <>
          <p>Your agents need your business context. On Overview, save a business brief with these details:</p>
          <ul>
            <li>What your SaaS does, its customers, current stage and team capacity.</li>
            <li>Your priorities, preferred tone and what a useful result looks like.</li>
            <li>Which tools you actually use and which records are available.</li>
            <li>What needs your approval and where information is still missing.</li>
          </ul>
          <blockquote>“We run a SaaS for small teams. We want smoother onboarding, fewer unresolved tickets and a clearer weekly business review. Use concise, friendly language. Ask before assuming feature support, pricing or legal requirements.”</blockquote>
          <p>Each agent receives the saved brief with your request. Update it when things change; it is not a live connection to your application or accounting system.</p>
          <p>Keep client identities, identity documents, bank details and passwords out of the brief. It is encrypted locally, but its contents are sent to your selected AI provider when you request a draft.</p>
          <button type="button" className="outline" onClick={() => onNavigate("Overview")}>Add my business brief<ArrowRight size={16} /></button>
        </> : null}
        {step === 2 ? <>
          <p>A useful request gives an outcome, the relevant facts and period, and the format you want back. Start with this fictional example before using business records.</p>
          <label className="field">Choose an agent to practice with
            <select value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>{AGENTS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </label>
          <blockquote>{lesson.prompt}</blockquote>
          <p>Loading this example only fills the composer. Review your saved brief, choose your connected AI provider, then select “Send to agent” when you are ready. That sends the request and your saved brief to your provider and uses your AI allowance or API balance. The fictional example does not replace your saved brief.</p>
          <div className="guide-actions">
            <button type="button" className="dark" onClick={() => onPrepareDraft(agent, lesson.prompt)}>{hasDraft ? "Replace my unsent draft with this example" : "Load practice prompt"}<ArrowRight size={16} /></button>
            <button type="button" className="outline" onClick={() => onNavigate("Connections")}>Set up my AI connection</button>
          </div>
          <p className="muted">One specialist draft uses one AI request. An Operations Lead team review uses up to four. No AI request runs just from viewing this guide or loading an example.</p>
        </> : null}
        {step === 3 ? <>
          <p>Your agent produces a draft for your review. It has not sent a customer message, deployed code or completed work in another app.</p>
          <ol>
            <li><strong>Check the evidence.</strong> Are the source, dates and numbers correct? What information is missing?</li>
            <li><strong>Check the interpretation.</strong> Are assumptions labelled? Does the advice fit your business?</li>
            <li><strong>Choose the next action.</strong> Edit the draft and carry out any approved action in the relevant business tool yourself.</li>
          </ol>
          <p>For another pass, include the relevant draft excerpt and your correction in a new request. Do not assume the agent can recall an earlier conversation automatically.</p>
          <p>Evidence shows previous runs and configuration events. A saved report is evidence that a draft was produced, not that its recommendations were executed.</p>
          <button type="button" className="outline" onClick={() => onNavigate("Evidence")}>See my activity record<ArrowRight size={16} /></button>
        </> : null}
        {step === 4 ? <>
          <p>Once a request gives you a useful result, use Automations to create a recurring review. Start with one, such as a morning business brief or weekly margin review.</p>
          <ol>
            <li>Choose the purpose, AI provider and cadence.</li>
            <li>Save the routine. New routines start paused.</li>
            <li>Review its instructions and expected AI usage before enabling it.</li>
            <li>Review the resulting reports and pause the routine whenever it is no longer useful.</li>
          </ol>
          <p>Routines run only while Corestrum is open and the vault is unlocked. The vault locks after 15 minutes without activity. This is not an always-on service. Repeated reviews use the records you supplied; they do not fetch fresh billing, analytics or bank records.</p>
          <p>Spending, pricing, payments, ads, legal decisions and changes in other systems stay with you. An agent cannot ask another agent to bypass those limits.</p>
          <div className="guide-actions">
            <button type="button" className="dark" onClick={() => onNavigate("Automations")}>Explore paused routines<ArrowRight size={16} /></button>
            <button type="button" className="outline" onClick={() => onNavigate("Overview")}>Go to my operations desk</button>
          </div>
          <p className="muted">Return to Getting started any time. Reading the guide does not activate a connection, enable a routine or certify your business.</p>
        </> : null}
        <div className="guide-pagination">
          <button type="button" className="outline" disabled={step === 0} onClick={() => move(step - 1)}><ArrowLeft size={16} />Back</button>
          {step < steps.length - 1 ? <button type="button" className="dark" onClick={() => move(step + 1)}>Next: {steps[step + 1]}<ArrowRight size={16} /></button> : <button type="button" className="outline" onClick={() => move(0)}>Review the guide again</button>}
        </div>
      </section>
      </Reveal>
    </div>
  );
}
