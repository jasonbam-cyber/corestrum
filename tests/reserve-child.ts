import { CustomerRuntime } from "../src/runtime/store";
const runtime = new CustomerRuntime("cedar", process.argv[2]);
try {
  runtime.reserve(process.argv[3], 100000);
  console.log("reserved");
} catch (e) {
  console.log((e as Error).message);
} finally {
  runtime.close();
}
