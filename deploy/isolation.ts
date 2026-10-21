import { bridgeEndpoint } from "../bridge/supabase/functions/waypoint-bridge/handler";
import { uuid } from "../src/production/common";
export const baseImage =
  "oven/bun@sha256:9e123d5fc069e29d519fd4c981afb61b8542ac80274771961136db1e4538d53e";
export type CustomerDeployment = {
  org: string;
  project: string;
  uid: number;
  secrets: string;
};
export function isolationCompose(
  image: string,
  customers: CustomerDeployment[],
  gatewaySecrets: string,
) {
  if (
    !/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(image) ||
    customers.length !== 2 ||
    new Set(customers.map((c) => c.org)).size !== 2 ||
    new Set(customers.map((c) => c.project)).size !== 2 ||
    new Set(customers.map((c) => c.uid)).size !== 2
  )
    throw new Error("TWO_DISTINCT_PINNED_CUSTOMERS_REQUIRED");
  const services: Record<string, any> = {},
    volumes: Record<string, object> = { gateway_data: {} },
    networks: Record<string, object> = { identity_egress: {} };
  const restricted = {
    image,
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    pids_limit: 64,
    mem_limit: "256m",
    cpus: 1,
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16777216"],
    restart: "unless-stopped",
    logging: {
      driver: "local",
      options: { "max-size": "10m", "max-file": "3" },
    },
  };
  const gatewaySockets: string[] = [];
  for (const c of customers) {
    if (
      !uuid(c.org) ||
      !Number.isInteger(c.uid) ||
      c.uid < 10001 ||
      c.uid > 19999 ||
      !c.secrets.startsWith("/")
    )
      throw new Error("INVALID_CUSTOMER_DEPLOYMENT");
    bridgeEndpoint(c.project);
    const name = "customer_" + c.uid,
      internal = "private_" + c.uid,
      egress = "outbound_" + c.uid,
      data = "data_" + c.uid,
      socket = "socket_" + c.uid;
    volumes[data] = {};
    volumes[socket] = {};
    networks[internal] = { internal: true };
    networks[egress] = {};
    services[name] = {
      ...restricted,
      user: `${c.uid}:${c.uid}`,
      command: ["worker.js"],
      environment: { CUSTOMER_CONFIG_FILE: "/run/secrets/config.json" },
      volumes: [
        `${data}:/data`,
        `${socket}:/run/runtime`,
        `${c.secrets}:/run/secrets:ro`,
      ],
      networks: [internal],
    };
    services["egress_" + c.uid] = {
      ...restricted,
      user: `${c.uid + 10000}:${c.uid + 10000}`,
      command: ["egress.js"],
      environment: { CUSTOMER_PROJECT_REF: c.project },
      networks: { [internal]: { aliases: ["egress"] }, [egress]: {} },
    };
    gatewaySockets.push(`${socket}:/run/customers/${c.org}:ro`);
  }
  if (!gatewaySecrets.startsWith("/"))
    throw new Error("ABSOLUTE_GATEWAY_SECRET_PATH_REQUIRED");
  services.gateway = {
    ...restricted,
    user: "10000:10000",
    group_add: customers.map((c) => String(c.uid)),
    environment: { PRODUCTION_CONFIG_FILE: "/run/secrets/config.json" },
    ports: ["127.0.0.1:8443:8443"],
    volumes: [
      "gateway_data:/data",
      ...gatewaySockets,
      `${gatewaySecrets}:/run/secrets:ro`,
    ],
    networks: ["identity_egress"],
  };
  return { services, volumes, networks };
}
if (import.meta.main) {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      "Usage: bun deploy/isolation.ts deployment.json > compose.json",
    );
  const input = await Bun.file(path).json();
  console.log(
    JSON.stringify(
      isolationCompose(input.image, input.customers, input.gatewaySecrets),
      null,
      2,
    ),
  );
}
