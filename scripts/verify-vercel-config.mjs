import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
const inc = cfg.functions?.["api/index.ts"]?.includeFiles;
if (typeof inc !== "string" || inc.trim() === "") {
  console.error(`includeFiles must be a non-empty string glob, got: ${JSON.stringify(inc)}`);
  process.exit(1);
}
for (const path of [
  "deploy/appliance",
  "dist/appliance",
  "docs/integrations/tms-http-v1.openapi.yaml",
  "docs/integrations/tms-http-v1.md"
]) {
  if (!fs.existsSync(path)) {
    console.error(`vercel.json includeFiles references missing path: ${path}`);
    process.exit(1);
  }
}
console.log("vercel.json includeFiles OK");
