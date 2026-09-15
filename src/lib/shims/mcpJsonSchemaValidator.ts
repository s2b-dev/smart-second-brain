/**
 * Build-time replacement for `@modelcontextprotocol/sdk/validation/ajv-provider.js`.
 *
 * The SDK's default JSON-schema validator is `ajv`, which compiles schemas with
 * `new Function` — dynamic code execution the plugin review flags. The SDK also
 * ships a `@cfworker/json-schema` provider that interprets schemas without
 * generating code; `vite.config.ts` aliases the ajv module here so the client
 * picks that one up under the name it imports.
 */
export { CfWorkerJsonSchemaValidator as AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
