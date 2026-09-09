import { readConfig } from "./config.js";
import { createApplication } from "./app.js";
const config = readConfig();
const runtime = await createApplication(config);
await runtime.app.listen(config.PORT, config.HOST);
console.log(`API listening on http://${config.HOST}:${config.PORT}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (!stopping) {
      stopping = true;
      void runtime.close().then(() => process.exit(0));
    }
  });
