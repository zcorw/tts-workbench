import SwaggerParser from "@apidevtools/swagger-parser";
const api = await SwaggerParser.validate("docs/openapi.yaml");
const ids = Object.values(api.paths).flatMap((p) =>
  Object.values(p)
    .filter((o) => o.operationId)
    .map((o) => o.operationId),
);
if (new Set(ids).size !== ids.length) throw new Error("Duplicate operationId");
console.log(
  `OpenAPI ${api.openapi}, API ${api.info.version}: ${ids.length} operations validated`,
);
