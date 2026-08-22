import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const cargoToml = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = new Set([packageJson.version, tauriConfig.version, cargoVersion]);

if (versions.size !== 1 || versions.has(undefined)) {
  console.error(`Version mismatch: package=${packageJson.version}, tauri=${tauriConfig.version}, cargo=${cargoVersion ?? "missing"}`);
  process.exit(1);
}

const expectedTag = `v${packageJson.version}`;
const requestedTag = process.argv[2] || process.env.GITHUB_REF_NAME;
if (requestedTag && requestedTag !== expectedTag) {
  console.error(`Release tag ${requestedTag} does not match app version ${expectedTag}.`);
  process.exit(1);
}

console.log(`Release versions aligned at ${packageJson.version}${requestedTag ? ` (${requestedTag})` : ""}.`);
