import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BACKUP_MAX_BYTES } from "./backup";
import { localApp } from "./server";
import { validateDesktopRelease } from "./release-config";

// Only the native supervisor launches this entrypoint. It holds the data lock and
// supplies a narrow environment; readiness goes over a private pipe, never a log.
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--data-dir" || !isAbsolute(args[1]!))
    throw Error("DESKTOP_LAUNCH_REQUIRED");
  const resources = resolve(dirname(process.execPath), "../Resources");
  const release = await validateDesktopRelease(JSON.parse(readFileSync(join(resources, "release-config.json"), "utf8")));
  let app: ReturnType<typeof localApp> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, maxRequestBodySize: BACKUP_MAX_BYTES + 8192,
    fetch(request) { return app ? app.fetch(request) : new Response(null, { status: 503 }); },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    app = localApp({ ...release, data: args[1]!, origin, assets: join(resources, "web") });
    const timer = setInterval(() => void app!.tick(), 30000);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      server.stop(true);
      app?.close();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.stdin.on("end", stop);
    process.stdin.resume();
    process.stdout.write(JSON.stringify({ type: "ready", url: `${origin}/#launch=${app.bootstrap}` }) + "\n");
  } catch (error) {
    server.stop(true);
    app?.close();
    throw error;
  }
}
main().catch(() => {
  // Provider/configuration/file contents must never appear in a crash transcript.
  process.exit(1);
});
