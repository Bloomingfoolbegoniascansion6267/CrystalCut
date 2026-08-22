import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const shouldBundle = process.argv.includes("--bundle");
const args = [tauriCli, "build", ...(shouldBundle ? [] : ["--no-bundle"])];
const result = spawnSync(process.execPath, args, {
  env: { ...process.env, CRYSTALCUT_TAURI_BUILD: "1" },
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
