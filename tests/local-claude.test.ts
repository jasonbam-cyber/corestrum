import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalClaude, runProcess, type Invocation, type ProcessResult, type Runner } from "../src/corestrum/local/claude";
import { LocalVault } from "../src/corestrum/local/vault";
import { draft, providerSnapshot, saveProvider } from "../src/corestrum/local/ai";
import { Operations } from "../src/corestrum/local/operations";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
async function fixture(label = "business") {
  const root = mkdtempSync(join(tmpdir(), "corestrum-claude-" + label + "-")); dirs.push(root);
  const executable = join(root, "claude"); writeFileSync(executable, "fixture, never executed", { mode: 0o700 });
  const calls: Invocation[] = [];
  const mode = { loggedIn: false, email: "owner@example.invalid", signature: 0, version: "2.1.296 (Claude Code)", config: "", result: { type: "result", subtype: "success", is_error: false, result: "Fixture business report", usage: { input_tokens: 12, output_tokens: 9 } } as any, code: 0, generate: undefined as undefined | ((i: Invocation) => Promise<ProcessResult>) };
  const run: Runner = async (i) => {
    calls.push(i);
    if (i.executable === "/usr/bin/codesign") return { code: mode.signature, stdout: "" };
    if (i.args[0] === "--version") return { code: 0, stdout: mode.version };
    if (i.args[0] === "auth") return { code: mode.loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn: mode.loggedIn, configDirectory: mode.config || i.env.CLAUDE_CONFIG_DIR, authMethod: mode.loggedIn ? "claude.ai" : "none", ...(mode.loggedIn ? { email: mode.email } : {}) }) };
    if (mode.generate) return mode.generate(i);
    return { code: mode.code, stdout: JSON.stringify(mode.result) };
  };
  const claude = new LocalClaude(join(root, "profile with spaces"), executable, run, "darwin");
  const vault = new LocalVault(join(root, "vault.enc")); await vault.unlock("fictional passphrase only");
  const connect = async () => { await claude.status(vault); mode.loggedIn = true; await claude.connect(vault, "sonnet", true); };
  return { root, executable, calls, mode, claude, vault, connect };
}

test("separate empty profile must be observed before sign-in and explicit connection; no tokens or emails stored", async () => {
  const f = await fixture();
  expect(await f.claude.status(f.vault)).toMatchObject({ signedIn: false, connected: false });
  expect(f.calls.filter((i) => i.args.includes("-p"))).toHaveLength(0);
  const command = await f.claude.setupCommand(f.vault);
  expect(command).toContain("/usr/bin/env -i");
  expect(command).toContain("CLAUDE_CONFIG_DIR=");
  expect(command).not.toContain("auth login --");
  expect(command).not.toContain("token");
  expect(f.calls[0]!.args.join(" ")).toContain('certificate leaf[subject.OU] = "Q6L2SF6YDW"');
  await expect(f.claude.connect(f.vault, "sonnet", true)).rejects.toThrow("CLAUDE_SIGN_IN_REQUIRED");
  f.mode.loggedIn = true;
  await expect(f.claude.connect(f.vault, "sonnet", false)).rejects.toThrow("CLAUDE_CONFIRM_ACCOUNT");
  await f.claude.connect(f.vault, "sonnet", true);
  expect(await f.claude.status(f.vault)).toMatchObject({ connected: true });
  expect(f.vault.get("provider:claude-code")).not.toContain(f.mode.email);
  expect(JSON.stringify(providerSnapshot(f.vault))).not.toContain(f.mode.email);
  expect(readFileSync(f.vault.path, "utf8")).not.toContain("sonnet");
});

test("pre-existing login, wrong profile, unsigned binary, missing CLI and old versions fail before inference", async () => {
  const f = await fixture();
  f.mode.loggedIn = true;
  await expect(f.claude.status(f.vault)).rejects.toThrow("CLAUDE_PROFILE_NOT_EMPTY");
  expect(f.vault.has("claude-profile")).toBe(false);
  f.mode.config = "/some-other-account";
  await expect(f.claude.status(f.vault)).rejects.toThrow("CLAUDE_PROFILE_MISMATCH");
  f.mode.signature = 1;
  await expect(f.claude.status(f.vault)).rejects.toThrow("CLAUDE_UNTRUSTED_BINARY");
  f.mode.signature = 0; f.mode.version = "2.1.267 (Claude Code)";
  await expect(f.claude.status(f.vault)).rejects.toThrow("CLAUDE_VERSION_REQUIRED");
  f.mode.version = "garbage";
  await expect(f.claude.status(f.vault)).rejects.toThrow("CLAUDE_VERSION_REQUIRED");
  rmSync(f.executable);
  await expect(f.claude.status(f.vault)).rejects.toThrow("CLAUDE_NOT_INSTALLED");
  expect(f.calls.some((i) => i.args.includes("-p"))).toBe(false);
});

test("private directories and executable permissions fail closed", async () => {
  const f = await fixture();
  chmodSync(f.executable, 0o777);
  await expect(f.claude.status(f.vault)).rejects.toThrow("CLAUDE_UNTRUSTED_BINARY");
  const link = join(f.root, "unsafe"); symlinkSync(f.claude.config, link);
  expect(() => new LocalClaude(link)).toThrow("CLAUDE_UNSAFE_PROFILE");
});

test("report is stdin-only with no inherited credentials, tools, history or account crossover", async () => {
  const f = await fixture(); await f.connect();
  const report = await f.claude.draft(f.vault, "operations", "Unique owner request", "Fictional notary A revenue 120");
  expect(report).toMatchObject({ text: "Fixture business report", provider: "claude-code", model: "sonnet", inputTokens: 12 });
  const i = f.calls.find((i) => i.args.includes("-p"))!;
  expect(i.input).toContain("Fictional notary A revenue 120");
  expect(i.args.join(" ")).not.toContain("Unique owner request");
  expect(i.args.join(" ")).not.toContain("Fictional notary A");
  expect(i.args).toContain("--restricted"); expect(i.args).toContain("--safe-mode");
  expect(i.args[i.args.indexOf("--tools") + 1]).toBe("");
  expect(i.args[i.args.indexOf("--disallowedTools") + 1]).toBe("mcp__*");
  expect(i.args).toContain("--strict-mcp-config");
  expect(i.args[i.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  expect(i.args[i.args.indexOf("--permission-prompts") + 1]).toBe("none");
  expect(i.args).toContain("--no-session-persistence");
  expect(i.args).toContain("--no-chrome");
  expect(Object.keys(i.env).sort()).toEqual(["CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "TMPDIR", "XDG_CONFIG_HOME"]);
  expect(i.env.HOME).toStartWith(realpathSync(f.root)); expect(i.cwd).toStartWith(realpathSync(f.root));
  expect(i.timeout).toBe(90000);
  f.mode.email = "different@example.invalid";
  await expect(f.claude.draft(f.vault, "operations", "no", "no")).rejects.toThrow("CLAUDE_ACCOUNT_CHANGED");
  expect(f.calls.filter((i) => i.args.includes("-p"))).toHaveLength(1);
});

test("account changes and disconnection during inference discard output without retry", async () => {
  const f = await fixture(); await f.connect();
  f.mode.generate = async () => { f.mode.email = "changed@example.invalid"; return { code: 0, stdout: JSON.stringify(f.mode.result) }; };
  await expect(f.claude.draft(f.vault, "operations", "test", "fixture")).rejects.toThrow("CLAUDE_ACCOUNT_CHANGED");
  await f.claude.connect(f.vault, "sonnet", true);
  f.mode.generate = async () => { f.vault.remove("provider:claude-code"); return { code: 0, stdout: JSON.stringify(f.mode.result) }; };
  await expect(f.claude.draft(f.vault, "operations", "test", "fixture")).rejects.toThrow("PROVIDER_CHANGED");
  expect(f.calls.filter((i) => i.args.includes("-p"))).toHaveLength(2);
});

test("provider errors and malformed/oversize content never become reports or raw errors", async () => {
  const f = await fixture(); await f.connect();
  for (const value of [ { type: "result", subtype: "error_during_execution", is_error: true, errors: ["secret fixture limit message"] }, { type: "result", subtype: "success", result: 8 }, { type: "result", subtype: "success", result: "x".repeat(24001) } ]) {
    f.mode.result = value;
    await expect(f.claude.draft(f.vault, "operations", "test", "fixture")).rejects.toThrow(/^CLAUDE_/);
  }
  f.mode.generate = async () => ({ code: 0, stdout: "not json" });
  await expect(f.claude.draft(f.vault, "operations", "test", "fixture")).rejects.toThrow("CLAUDE_INVALID_RESPONSE");
  expect(f.calls.filter((i) => i.args.includes("-p"))).toHaveLength(4);
});

test("cancellation terminates in-flight generation and permits a later explicit run", async () => {
  const f = await fixture(); await f.connect();
  let started!: () => void; const began = new Promise<void>((r) => started = r);
  f.mode.generate = (i) => new Promise((_, reject) => { i.signal!.addEventListener("abort", () => reject(new Error("CLAUDE_CANCELLED"))); started(); });
  const pending = f.claude.draft(f.vault, "operations", "test", "fixture");
  await began; f.claude.cancel();
  await expect(pending).rejects.toThrow("CLAUDE_CANCELLED");
  f.mode.generate = undefined;
  expect((await f.claude.draft(f.vault, "operations", "test", "fixture")).provider).toBe("claude-code");
});

test("two fictional businesses keep profile, prompt, sealed report and audit boundaries", async () => {
  const a = await fixture("notary"), b = await fixture("bookshop");
  await a.connect(); await b.connect();
  a.vault.set("business-context", "FICTIONAL NOTARY A"); b.vault.set("business-context", "FICTIONAL BOOKSHOP B");
  const make = (f: typeof a) => new Operations(join(f.root, "ops.sqlite"), f.root, f.vault, async () => {}, (v, p, role, prompt, context) => f.claude.draft(v, role, prompt, context));
  const opA = make(a), opB = make(b);
  try {
    const resultA = await opA.run("operations", "claude-code", "Draft my first report");
    await opB.run("operations", "claude-code", "Draft my first report");
    const inputA = a.calls.find((i) => i.args.includes("-p"))!.input!;
    const inputB = b.calls.find((i) => i.args.includes("-p"))!.input!;
    expect(inputA).not.toContain("BOOKSHOP"); expect(inputB).not.toContain("NOTARY");
    expect(a.claude.config).not.toBe(b.claude.config);
    expect(() => opB.report(resultA.id)).toThrow("NOT_FOUND");
    expect(opA.verifyLedger()).toBe(true); expect(opB.verifyLedger()).toBe(true);
    expect(readFileSync(join(a.root, "ops.sqlite")).includes(Buffer.from("Fixture business report"))).toBe(false);
    await expect(b.claude.draft(a.vault, "operations", "test", "fixture")).rejects.toThrow("CLAUDE_PROFILE_MISMATCH");
  } finally { opA.db.close(); opB.db.close(); }
});

test("API key adapter cannot accept or transmit a Claude subscription token", async () => {
  const f = await fixture(); let called = false;
  await expect(saveProvider(f.vault, "claude-code", "fictional-subscription-token", "sonnet", (async () => { called = true; return new Response(); }) as unknown as typeof fetch)).rejects.toThrow("CLAUDE_LOCAL_CONNECTION_REQUIRED");
  await expect(draft(f.vault, "claude-code", "operations", "test", "fixture")).rejects.toThrow("CLAUDE_LOCAL_CONNECTION_REQUIRED");
  expect(called).toBe(false);
});

const invoke = (source: string, change: Partial<Invocation> = {}) => runProcess({ executable: process.execPath, args: ["-e", source], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeout: 2000, ...change });
test("real subprocess runner bounds stdout/stderr, timeout, cancellation and private stdin", async () => {
  expect(await invoke('console.log(await Bun.stdin.text())', { input: "fictional input" })).toEqual({ code: 0, stdout: "fictional input\n" });
  await expect(invoke('process.stdout.write("x".repeat(600000))')).rejects.toThrow("CLAUDE_OUTPUT_LIMIT");
  await expect(invoke('process.stderr.write("x".repeat(20000))')).rejects.toThrow("CLAUDE_OUTPUT_LIMIT");
  await expect(invoke('setInterval(()=>{},1000)', { timeout: 50 })).rejects.toThrow("CLAUDE_OUTCOME_UNKNOWN");
  const control = new AbortController(); const pending = invoke('setInterval(()=>{},1000)', { signal: control.signal }); control.abort();
  await expect(pending).rejects.toThrow("CLAUDE_CANCELLED");
  await expect(invoke('throw Error("private fixture detail")')).resolves.toMatchObject({ code: 1, stdout: "" });
});
