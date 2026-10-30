import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import YAML from "yaml";
const compose = YAML.parse(readFileSync("compose.yaml", "utf8"));
assert.deepEqual(Object.keys(compose.services).sort(), ["app", "db"]);
const ports = compose.services.app.ports;
assert.equal(ports.length, 2);
assert.deepEqual(
  ports.map((port) => port.target),
  [3000, 3001],
);
assert.deepEqual(
  ports.map((port) => port.published),
  ["${APP_HOST_PORT:-8080}", "${CMS_HOST_PORT:-8081}"],
);
for (const port of ports) {
  assert.equal(port.host_ip, "127.0.0.1");
  assert.equal(port.protocol, "tcp");
}
assert.equal(compose.services.app.environment.PORT, "3000");
assert.equal(compose.services.app.environment.CMS_PORT, "3001");
assert.equal(compose.services.app.environment.WEB_DIST, "/app/apps/web/dist");
assert.equal(compose.services.app.environment.CMS_DIST, "/app/apps/cms/dist");
assert.equal(compose.services.app.depends_on.db.condition, "service_healthy");
assert.equal(compose.services.app.read_only, true);
assert.equal(compose.services.db.ports, undefined);
assert.deepEqual(compose.services.db.volumes, [
  "postgres_data:/var/lib/postgresql/data",
]);
const dockerfile = readFileSync("Dockerfile", "utf8");
assert.match(dockerfile, /COPY apps\/cms\/package\*\.json \.\/apps\/cms\//);
assert.match(dockerfile, /RUN cd apps\/cms && npm ci/);
assert.match(dockerfile, /RUN cd apps\/cms && npm run build/);
assert.match(
  dockerfile,
  /COPY --from=build --chown=node:node \/app\/apps\/cms\/dist \.\/apps\/cms\/dist/,
);
assert.match(dockerfile, /EXPOSE 3000 3001/);
assert.match(dockerfile, /HEALTHCHECK[^\n]*process\.env\.CMS_PORT/);
assert.match(dockerfile, /CMD \["node","apps\/api\/dist\/main\.js"\]/);
const workflow = YAML.parse(
  readFileSync(".github/workflows/deploy.yml", "utf8"),
);
assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
assert.equal(workflow.concurrency["cancel-in-progress"], false);
for (const step of workflow.jobs.deploy.steps)
  if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
assert.ok(
  workflow.jobs.deploy.steps.some((step) =>
    step.run?.includes("npm --prefix apps/cms run build"),
  ),
);
console.log(
  "Same-container dual-loopback-port, CMS packaging and manual workflow checks passed",
);
