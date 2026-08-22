import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tauriCli = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
);
const result = spawnSync(process.execPath, [tauriCli, "build", "--no-bundle"], {
  env: { ...process.env, CLEARCUT_TAURI_BUILD: "1" },
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
