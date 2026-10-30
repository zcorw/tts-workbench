import { readConfig } from "./config.js";
import { createApplication } from "./app.js";
const config = readConfig();
const runtime = await createApplication(config);
await runtime.listen();
console.log(`API listening on http://${config.HOST}:${config.PORT}`);
if (runtime.cmsServer)
  console.log(
    `CMS listening on http://${config.HOST}:${config.CMS_PORT}${config.CMS_PUBLIC_ORIGIN ? "" : " (API disabled until CMS_PUBLIC_ORIGIN is configured)"}`,
  );
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (!stopping) {
      stopping = true;
      void runtime.close().then(() => process.exit(0));
    }
  });
