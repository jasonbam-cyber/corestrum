import type { Member, Session } from "./identity";
export const escape = (v: unknown) =>
  String(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const portalCss = `:root{font:16px system-ui,sans-serif;color:#182522;background:#f7f9f8;color-scheme:light}*{box-sizing:border-box}body{margin:0}header,main{max-width:1080px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;gap:16px;align-items:center;border-bottom:1px solid #d5dfd9}a{color:inherit}main{padding-top:48px}h1{font-size:clamp(32px,6vw,60px);letter-spacing:-.045em;line-height:1.05;max-width:780px}h2{font-size:23px;letter-spacing:-.025em}p{line-height:1.65;max-width:720px;color:#42574c}section{padding:28px;border:1px solid #cbd8d0;border-radius:16px;background:white;margin:24px 0}button,.button{display:inline-block;border:1px solid #182522;background:#182522;color:white;border-radius:8px;padding:12px 18px;font:inherit;text-decoration:none;cursor:pointer}button:hover,.button:hover{background:#304c3e}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #496f18;outline-offset:4px}.badge{background:#ddf69c;border-radius:99px;padding:7px 12px;font-size:13px}label{display:block;margin:16px 0 6px;font-weight:600}input,select,textarea{font:inherit;display:block;width:100%;max-width:650px;padding:12px;border:1px solid #718379;border-radius:7px;margin-bottom:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;padding:18px;background:#eef3ef;border-radius:9px;font-size:13px}form{margin:16px 0}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.muted{font-size:14px;color:#4e6257}footer{margin-top:40px;color:#4e6257;font-size:13px}@media(max-width:480px){header,main{padding:18px}section{padding:18px}header .badge{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;
export function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Waypoint</title><link rel="stylesheet" href="/portal.css"></head><body><header><a href="/" aria-label="Waypoint home"><strong>↗ waypoint</strong></a><span class="badge">Customer workspace</span></header><main>${body}<footer>Waypoint is a working name. Security controls are under qualification; no SOC 2 report has been issued.</footer></main></body></html>`;
}
export function portal(
  session?: Session,
  members: Member[] = [],
  result?: unknown,
  connection?: { installations?: Array<{ id: string; state: string }> },
) {
  if (!session)
    return page(
      "Sign in",
      `<span class="badge">Your team. Your data. Your control.</span><h1>Give your agents a clear boundary.</h1><p>Sign in through your organization’s identity provider. Multi-factor authentication and an approved workspace membership are required.</p><a class="button" href="/auth/login">Sign in securely</a>`,
    );
  const csrf = `<input type="hidden" name="csrf" value="${escape(session.csrf)}">`;
  const selected = members.find((m) => m.org === session.org);
  const action = (command: string, label: string, extra = "") =>
    `<form method="post" action="/onboarding/${command}">${csrf}${extra}<button>${label}</button></form>`;
  const current = connection?.installations?.find((i) => i.state !== "revoked");
  const installation =
    '<label for="installation">Installation ID</label><input id="installation" name="installation" required pattern="[a-f0-9-]{36}" autocomplete="off" value="' +
    escape(current?.id ?? "") +
    '">';
  return page(
    "Connect your app",
    `<h1>Your data stays in your app.</h1><p>Connect a specific Supabase project, choose the account records your agent may read, and verify the grant. Database passwords stay in your Supabase project.</p>${result !== undefined ? `<section role="status"><h2>Request result</h2><pre>${escape(JSON.stringify(result, null, 2))}</pre></section>` : ""}<section><h2>1. Choose your workspace</h2><form method="post" action="/auth/customer">${csrf}<label for="org">Approved workspaces</label><select id="org" name="org">${members.map((m) => `<option value="${escape(m.org)}" ${m.org === session.org ? "selected" : ""}>${escape(m.name)} · ${escape(m.role)}</option>`).join("")}</select><button>Open workspace</button></form></section>${selected ? `<section><h2>${escape(selected.name)}</h2><p>Project destinations are provisioned by the operator and cannot be redirected by an agent or a browser request.</p>${action("snapshot", "Check connection status")}${selected.role === "owner" ? `<h2>2. Prepare the read grant</h2><p>Enter the downstream account UUIDs you approve, separated by commas. The installation manifest contains a public signing key; it contains no database password.</p>${action("prepare", "Create installation manifest", '<label for="accounts">Allowed account UUIDs</label><textarea id="accounts" name="accounts" required rows="3"></textarea>')}<h2>3. Install in your Supabase project</h2><p>Give the manifest and the repository’s customer installation guide to your developer. They apply the restricted schema, map the approved fields, and deploy the Edge Function. No administrator key is sent here.</p><h2>4. Verify the installation</h2>${action("verify", "Verify project and grant", installation)}<h2>5. Prove a scoped read</h2>${action("read", "Read approved record", installation.replaceAll('id="installation"', 'id="read-installation"').replaceAll('for="installation"', 'for="read-installation"') + '<label for="account">Approved account UUID</label><input id="account" name="account" required><label for="resource">Record UUID</label><input id="resource" name="resource" required>')}<h2>Disconnect</h2><p>This immediately blocks new requests from this workspace and removes its signing key. Also deactivate the grant in Supabase to reject any request already in flight.</p>${action("revoke", "Disconnect installation", installation.replaceAll('id="installation"', 'id="revoke-installation"').replaceAll('for="installation"', 'for="revoke-installation"'))}` : "<p>Your viewer role can inspect connection status. An owner manages grants and reads.</p>"}</section>` : ""}<form action="/auth/logout" method="post">${csrf}<button>Sign out</button></form>`,
  );
}
