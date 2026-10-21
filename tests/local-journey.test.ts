import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import { localApp, type LocalConfig } from "../src/corestrum/local/server";
import { signLicense } from "../src/corestrum/license";
const dirs: string[] = [], apps: ReturnType<typeof localApp>[] = [];
afterEach(() => { apps.splice(0).forEach(a => { try { a.close(); } catch {} }); dirs.splice(0).forEach(d => rmSync(d, {recursive:true,force:true})); });
const localPassword = "fictional local passphrase";
const backupPassword = "fictional backup passphrase";
test("two fictional complimentary customers complete local first-report, paused routine, restart and fresh-device recovery with fixture AI", async () => {
  const pair = await generateKeyPair("EdDSA", {extractable:true});
  const publicKey = await exportJWK(pair.publicKey), privateKey = await exportJWK(pair.privateKey);
  const prompts: string[] = [];
  const transport = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init: any) => {
    if (url === "https://api.openai.com/v1/models") return Response.json({data:[{id:"fixture-model"}]});
    if (url !== "https://api.openai.com/v1/responses") throw Error("FIXTURE_UNEXPECTED_NETWORK");
    const body = JSON.parse(init.body); prompts.push(body.input);
    return Response.json({output:[{type:"message",content:[{type:"output_text",text:body.input.includes("FICTIONAL NOTARY") ? "Fixture notary report: review supplied totals." : "Fixture bookshop report: review supplied totals."}]}],usage:{input_tokens:4,output_tokens:5}});
  }) as typeof fetch);
  let nextPort = 4410;
  async function session(config: LocalConfig) {
    const app=localApp(config); apps.push(app);
    let cookie="",csrf="";
    const post = async (path:string,body:unknown,csrfOverride?:string) => app.fetch(new Request(config.origin+path,{method:"POST",headers:{origin:config.origin,"content-type":"application/json",cookie,"x-csrf-token":csrfOverride ?? csrf},body:JSON.stringify(body)}));
    const start=await post("/api/local/session",{token:app.bootstrap});cookie=start.headers.get("set-cookie")!.split(";")[0]!;csrf=(await start.json()).csrf;
    expect((await post("/api/local/unlock",{password:localPassword})).status).toBe(200);
    const state=async()=> (await app.fetch(new Request(config.origin+"/api/local/state",{headers:{cookie}}))).json();
    return {app,post,state,config};
  }
  async function fresh(workspace:string) {
    const data=mkdtempSync(join(tmpdir(),"corestrum-journey-"));dirs.push(data);
    const config:LocalConfig={data,origin:`http://127.0.0.1:${nextPort++}`,cloudOrigin:"https://fixture.corestrum.invalid",licensePublicKey:publicKey,environment:"staging",assets:data};
    const s=await session(config);const device=await (await s.post("/api/local/activation",{})).json();
    const license=await signLicense({id:randomUUID(),workspace,device:device.device,plan:"complimentary",major:null,updatesUntil:null,expires:null,grantId:randomUUID(),issued:Math.floor(Date.now()/1000),environment:"staging"},privateKey,"fixture");
    expect((await s.post("/api/local/license",{license})).status).toBe(200);
    expect((await s.state()).license.plan).toBe("complimentary");
    return {...s,device:device.device};
  }
  try {
    const workspaceA=randomUUID(),workspaceB=randomUUID(),a=await fresh(workspaceA),b=await fresh(workspaceB);
    const resultIds:string[]=[];
    for (const [s,label] of [[a,"FICTIONAL NOTARY"],[b,"FICTIONAL BOOKSHOP"]] as const) {
      expect((await s.post("/api/local/context",{context:label+": owner supplied summary only"})).status).toBe(200);
      expect((await s.post("/api/local/provider",{provider:"openai",key:"fixture-key-customer-owned-only",model:"fixture-model"})).status).toBe(200);
      const report=await s.post("/api/local/draft",{provider:"openai",agent:"operations",prompt:"Prepare my first report. Identify missing facts.",specialists:[]});const reportBody=await report.json();expect(reportBody.error).toBeUndefined();expect(report.status).toBe(200);resultIds.push(reportBody.id);
      const routine=await (await s.post("/api/local/automations",{template:"custom-workflow",provider:"openai",name:"Owner review",hours:24,instruction:"Review the supplied business summary"})).json();
      expect((await s.state()).operations.automations[0].enabled).toBe(0);
      await s.post("/api/local/automations/toggle",{id:routine.id,enabled:true});
      await s.post("/api/local/automations/toggle",{id:routine.id,enabled:false});await s.app.tick();
    }
    expect(prompts).toHaveLength(2);expect(prompts[0]).toContain("NOTARY");expect(prompts[0]).not.toContain("BOOKSHOP");expect(prompts[1]).not.toContain("NOTARY");
    expect((await b.post("/api/local/report",{id:resultIds[0]})).status).toBe(403);
    expect((await a.post("/api/local/backup/export",{password:backupPassword},"wrong")).status).toBe(403);
    const archiveA=JSON.stringify(await (await a.post("/api/local/backup/export",{password:backupPassword})).json());
    const archiveB=JSON.stringify(await (await b.post("/api/local/backup/export",{password:backupPassword})).json());
    expect(archiveA).not.toContain("fixture-key");expect(archiveA).not.toContain("NOTARY");
    await a.post("/api/local/lock",{});
    expect((await a.post("/api/local/backup/export",{password:backupPassword})).status).toBe(403);
    a.app.close();const again=await session(a.config);
    expect((await (await again.post("/api/local/report",{id:resultIds[0]})).json()).text).toContain("notary");
    expect((await again.state()).operations.ledgerIntact).toBe(true);
    const restored=await fresh(workspaceA);expect(restored.device).not.toBe(a.device);
    expect((await restored.post("/api/local/backup/restore",{archive:archiveA,password:backupPassword})).status).toBe(403);
    expect(await (await restored.post("/api/local/backup/restore",{archive:archiveB,password:backupPassword,confirmed:true})).json()).toEqual({error:"BACKUP_WORKSPACE_MISMATCH"});
    const response=await restored.post("/api/local/backup/restore",{archive:archiveA,password:backupPassword,confirmed:true});expect(response.status).toBe(200);
    const state=await restored.state();expect(state.businessContext).toContain("NOTARY");expect(state.operations.automations[0].enabled).toBe(0);expect(state.providers.every((p:any)=>!p.connected)).toBe(true);expect(state.operations.ledgerIntact).toBe(true);
    expect((await (await restored.post("/api/local/report",{id:resultIds[0]})).json()).text).toContain("notary");
    expect((await (await restored.post("/api/local/activation",{})).json()).device).toBe(restored.device);
    expect(await (await restored.post("/api/local/backup/restore",{archive:archiveA,password:backupPassword,confirmed:true})).json()).toEqual({error:"RESTORE_REQUIRES_EMPTY_WORKSPACE"});
    expect(prompts).toHaveLength(2);
  } finally {transport.mockRestore();}
});
