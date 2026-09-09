import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import YAML from "yaml";
const compose = YAML.parse(readFileSync("compose.yaml", "utf8"));
const ports = Object.values(compose.services).flatMap((s) => s.ports ?? []);
assert.equal(ports.length, 1);
assert.equal(ports[0].host_ip, "127.0.0.1");
assert.equal(compose.services.db.ports, undefined);
const workflow = YAML.parse(
  readFileSync(".github/workflows/deploy.yml", "utf8"),
);
assert.ok(
  workflow.on.workflow_dispatch === null ||
    typeof workflow.on.workflow_dispatch === "object",
);
assert.equal(workflow.concurrency["cancel-in-progress"], false);
for (const step of workflow.jobs.deploy.steps)
  if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
console.log(
  "Compose single-loopback-port and workflow structure checks passed",
);
