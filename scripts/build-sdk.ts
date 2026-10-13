/**
 * Builds the publishable @proofdesk/sdk into packages/sdk/publish: compiled ESM + type
 * declarations (no runtime dependencies; Node 18+, browsers, Deno, Bun, edge), a package.json
 * pointing at them, and the README. The workspace keeps importing the TypeScript source.
 *
 *   npm run sdk:build && (cd packages/sdk/publish && npm pack)   # or npm publish
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "../packages/sdk");
const out = join(dir, "publish");
rmSync(out, { recursive: true, force: true });
execFileSync("npx", ["tsc", "-p", join(dir, "tsconfig.build.json")], { stdio: "inherit" });

const src = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const pkg = {
  name: src.name,
  version: src.version,
  description: src.description,
  license: src.license,
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "README.md"],
  sideEffects: false,
  engines: { node: ">=18" },
  keywords: ["proof desk", "conditional payments", "verification", "escrow alternative", "agents", "mcp"],
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
copyFileSync(join(dir, "README.md"), join(out, "README.md"));
console.log(`built ${pkg.name}@${pkg.version} in ${out}`);
