import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseImage, isolationCompose } from "../deploy/isolation";
const context = process.env.TEST_DOCKER_CONTEXT;
const docker = ["docker", ...(context ? ["--context", context] : [])];
async function run(args: string[], input?: string, fail = true) {
  const p = Bun.spawn([...docker, ...args], {
    stdin: input ? new Blob([input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code && fail)
    throw new Error(args.slice(0, 3).join(" ") + ": " + err + out);
  return { out, err, code };
}
const prefix = "wp-isolation-" + randomUUID().slice(0, 8),
  tag = prefix + ":test",
  dir = mkdtempSync(join(tmpdir(), prefix));
const customers = [
  {
    org: randomUUID(),
    project: "aaaaaaaaaaaaaaaaaaaa",
    uid: 10001,
    secrets: "/unused/a",
  },
  {
    org: randomUUID(),
    project: "bbbbbbbbbbbbbbbbbbbb",
    uid: 10002,
    secrets: "/unused/b",
  },
];
const createdVolumes: string[] = [];
let composeFile = "";
let assertions = 0;
const check = (yes: unknown, message: string) => {
  assertions++;
  if (!yes) throw new Error(message);
};
try {
  await run([
    "build",
    "-f",
    "deploy/Dockerfile",
    "--build-arg",
    `BUN_IMAGE=${baseImage}`,
    "-t",
    tag,
    ".",
  ]);
  const image = (
    await run(["image", "inspect", tag, "--format", "{{.Id}}"])
  ).out.trim();
  const compose = isolationCompose(image, customers, "/unused/gateway");
  delete compose.services.gateway; // Identity protocol is separately tested; no demo login in this artifact.
  for (const c of customers) {
    const seed = `${prefix}-secrets-${c.uid}`,
      data = `${prefix}-data-${c.uid}`,
      socket = `${prefix}-socket-${c.uid}`;
    for (const v of [seed, data, socket]) {
      await run(["volume", "create", v]);
      createdVolumes.push(v);
    }
    const token = randomBytes(32).toString("hex"),
      key = randomBytes(32).toString("base64");
    const config = {
      org: c.org,
      project: c.project,
      database: "/data/customer.sqlite",
      keyFile: "/run/secrets/key",
      tokenFile: "/run/secrets/token",
      socket: "/run/runtime/worker.sock",
      proxy: "http://egress:8080/bridge",
    };
    // Synthetic test credentials only; production credentials must be injected from an approved secret manager.
    const init = `const fs=await import('node:fs');const s=JSON.parse(await Bun.stdin.text());for(const p of ['/data','/run/runtime','/run/secrets']){fs.chownSync(p,s.uid,s.uid);fs.chmodSync(p,p==='/run/runtime'?0o770:0o700)}for(const [f,v] of Object.entries({config:JSON.stringify(s.config),key:Buffer.from(s.key,'base64'),token:s.token})){const p='/run/secrets/'+(f==='config'?'config.json':f);fs.writeFileSync(p,v,{mode:0o400});fs.chownSync(p,s.uid,s.uid)}`;
    await run(
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "-v",
        `${seed}:/run/secrets`,
        "-v",
        `${data}:/data`,
        "-v",
        `${socket}:/run/runtime`,
        baseImage,
        "bun",
        "-e",
        init,
      ],
      JSON.stringify({ uid: c.uid, config, key, token }),
    );
    compose.volumes[`seed_${c.uid}`] = { external: true, name: seed };
    compose.volumes[`data_${c.uid}`] = { external: true, name: data };
    compose.volumes[`socket_${c.uid}`] = { external: true, name: socket };
    compose.services[`customer_${c.uid}`].volumes = [
      `data_${c.uid}:/data`,
      `socket_${c.uid}:/run/runtime`,
      `seed_${c.uid}:/run/secrets:ro`,
    ];
    // Keep ephemeral tokens in memory for the trusted operator probe only.
    (c as any).token = token;
  }
  composeFile = join(dir, "compose.json");
  await Bun.write(composeFile, JSON.stringify(compose));
  await run(["compose", "-p", prefix, "-f", composeFile, "up", "-d"]);
  for (const c of customers) {
    const id = (
      await run([
        "compose",
        "-p",
        prefix,
        "-f",
        composeFile,
        "ps",
        "-q",
        `customer_${c.uid}`,
      ])
    ).out.trim();
    const inspection = JSON.parse((await run(["inspect", id])).out)[0];
    check(
      inspection.Config.User === `${c.uid}:${c.uid}` &&
        inspection.HostConfig.ReadonlyRootfs,
      "Root user or writable root",
    );
    check(
      inspection.HostConfig.CapDrop.includes("ALL") &&
        inspection.HostConfig.SecurityOpt.includes("no-new-privileges:true"),
      "Privilege escalation possible",
    );
    check(
      Object.keys(inspection.NetworkSettings.Networks).length === 1,
      "Customer joined extra network",
    );
    const net = Object.keys(inspection.NetworkSettings.Networks)[0];
    check(
      JSON.parse((await run(["network", "inspect", net])).out)[0].Internal,
      "Customer has default internet route",
    );
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const p = await run(
        [
          "exec",
          id,
          "bun",
          "-e",
          "process.exit(require('node:fs').existsSync('/run/runtime/worker.sock')?0:1)",
        ],
        undefined,
        false,
      );
      if (!p.code) {
        ready = true;
        break;
      }
      await Bun.sleep(100);
    }
    check(ready, "Worker did not start");
    const probe = `const fs=await import('node:fs');const input=JSON.parse(await Bun.stdin.text());const call=async(org,command,values)=>fetch('http://worker/command',{unix:'/run/runtime/worker.sock',method:'POST',headers:{authorization:'Bearer '+input.token,'content-type':'application/json'},body:JSON.stringify({principal:{org,actor:'a'.repeat(64),role:'owner'},command,input:values})});const a=await call(input.org,'snapshot',{});const b=await call(input.other,'snapshot',{});const c=await call(input.org,'prepare',{accounts:[input.account]});let rootWrite=false;try{fs.writeFileSync('/app/forbidden','x');rootWrite=true}catch{}let internet=false;try{await fetch('https://example.com',{signal:AbortSignal.timeout(1000)});internet=true}catch{}console.log(JSON.stringify({own:a.status,foreign:b.status,prepare:c.status,rootWrite,internet,foreignMount:fs.existsSync('/run/customers/'+input.other),envLeak:!!process.env.PROTOTYPE_MODE,uid:process.getuid()}));`;
    const other = customers.find((x) => x.org !== c.org)!;
    const result = JSON.parse(
      (
        await run(
          ["exec", "-i", id, "bun", "-e", probe],
          JSON.stringify({
            org: c.org,
            other: other.org,
            token: (c as any).token,
            account: randomUUID(),
          }),
        )
      ).out,
    );
    check(
      result.own === 200 && result.prepare === 200 && result.foreign === 404,
      "Customer auth boundary failed",
    );
    check(
      !result.rootWrite &&
        !result.internet &&
        !result.foreignMount &&
        !result.envLeak &&
        result.uid === c.uid,
      "Runtime sandbox boundary failed",
    );
    const files = (
      await run([
        "exec",
        id,
        "bun",
        "-e",
        "console.log(require('node:fs').readdirSync('/app').join(','))",
      ])
    ).out;
    check(
      !files.includes("gateway.ts") &&
        !files.includes("main.tsx") &&
        !files.includes("node_modules"),
      "Demo/source shipped in runtime image",
    );
  }
  // Verify mount identity defense even when the operator accidentally swaps a data volume.
  const a = customers[0],
    b = customers[1];
  const wrong = await run(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${a.uid}:${a.uid}`,
      "-v",
      `${prefix}-data-${b.uid}:/data`,
      "-v",
      `${prefix}-secrets-${a.uid}:/run/secrets:ro`,
      "-v",
      `${prefix}-socket-${a.uid}:/run/runtime`,
      "-e",
      "CUSTOMER_CONFIG_FILE=/run/secrets/config.json",
      image,
      "worker.js",
    ],
    undefined,
    false,
  );
  check(wrong.code !== 0, "Swapped customer volume accepted");
  console.log(
    JSON.stringify({
      ok: true,
      assertions,
      image,
      customers: 2,
      separateUids: true,
      separateVolumes: true,
      defaultDenyWorkerEgress: true,
      rootFilesystemReadOnly: true,
      wrongCustomerDenied: true,
      liveCustomerData: false,
    }),
  );
} finally {
  if (composeFile)
    await run(
      ["compose", "-p", prefix, "-f", composeFile, "down", "--remove-orphans"],
      undefined,
      false,
    );
  for (const v of createdVolumes)
    await run(["volume", "rm", v], undefined, false);
  await run(["image", "rm", tag], undefined, false);
  rmSync(dir, { recursive: true, force: true });
}
