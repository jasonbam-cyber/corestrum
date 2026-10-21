import { resolve } from "node:path";
import { startGateway } from "./gateway";
const port = Number(process.env.PROTOTYPE_PORT ?? "4381");
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  [3040, 7474].includes(port)
)
  throw new Error("INVALID_PROTOTYPE_PORT");
const app = await startGateway({
  root: resolve(import.meta.dir, "../.data"),
  port,
  mode: process.env.PROTOTYPE_MODE ?? "",
  dist: resolve(import.meta.dir, "../dist"),
});
console.log(
  `Synthetic prototype: ${app.origin}. Customer runtime PIDs: ${JSON.stringify(app.pids)}`,
);
const stop = async () => {
  await app.stop();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
