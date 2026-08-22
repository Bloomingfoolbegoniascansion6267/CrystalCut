import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const englishCatalog = readFileSync(new URL("../src/i18n/messages.ts", import.meta.url), "utf8").split("export const ko:")[0];
const definedIds = new Set([...englishCatalog.matchAll(/"([a-z][A-Za-z0-9.]+)"\s*:/g)].map((match) => match[1]));
const failures = [];

const translationSource = readFileSync(new URL("../src/i18n/translations.ts", import.meta.url), "utf8");
const statusIds = [...definedIds].filter((id) => id.startsWith("status."));
const messageIds = (source) => [...source.matchAll(/"([a-z][A-Za-z0-9.]+)"\s*:/g)].map((match) => match[1]);
const exportBlock = (name, nextName) => {
  const start = translationSource.indexOf(`export const ${name}`);
  const end = nextName ? translationSource.indexOf(`export const ${nextName}`, start) : translationSource.length;
  return translationSource.slice(start, end);
};
const supplement = (name) => readFileSync(new URL(`../src/i18n/supplements/${name}.ts`, import.meta.url), "utf8");
const localeSources = {
  ja: [supplement("ja"), exportBlock("ja", "zhCN")],
  "zh-CN": [supplement("zh-cn"), exportBlock("zhCN", "zhTW")],
  // zh-TW programmatically localizes every zh-CN supplement entry, then overrides
  // product terminology and its existing hand-written core strings.
  "zh-TW": [supplement("zh-cn"), exportBlock("zhCN", "zhTW"), exportBlock("zhTW", "es")],
  es: [supplement("es"), exportBlock("es", "de")],
  de: [supplement("de"), exportBlock("de", "fr")],
  fr: [supplement("fr"), exportBlock("fr", "ptBR")],
  "pt-BR": [supplement("pt-br"), exportBlock("ptBR")],
};

for (const [locale, sources] of Object.entries(localeSources)) {
  const localizedIds = new Set([...statusIds, ...sources.flatMap(messageIds)]);
  const missing = [...definedIds].filter((id) => !localizedIds.has(id));
  if (missing.length) failures.push(`${locale}: ${missing.length} untranslated messages (${missing.join(", ")})`);
}

function visit(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== "i18n") visit(path);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    const source = readFileSync(path, "utf8");
    const displayPath = relative(projectRoot, path);
    if (/[가-힣]/.test(source)) failures.push(`${displayPath}: user-facing Korean literal outside src/i18n`);
    for (const match of source.matchAll(/\bt\(\s*"([a-z][A-Za-z0-9.]+)"/g)) {
      if (!definedIds.has(match[1])) failures.push(`${displayPath}: missing English message ${match[1]}`);
    }
  }
}

visit(sourceRoot);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`i18n check passed: ${definedIds.size} messages complete in 9 locales; no Korean UI literals outside catalogs.`);
