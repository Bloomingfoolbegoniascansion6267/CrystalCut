import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { CrystalCutI18nProvider } from "./i18n/I18nProvider";
import { detectSystemLocale, isLanguagePreference, type LanguagePreference } from "./i18n/locale";
import { invoke } from "@tauri-apps/api/core";

async function loadInitialLanguage(): Promise<LanguagePreference> {
  if (!window.__TAURI_INTERNALS__) return "system";
  try {
    const preferences = await invoke<{ language?: unknown }>("load_app_preferences");
    return isLanguagePreference(preferences.language) ? preferences.language : "system";
  } catch {
    return "system";
  }
}

async function bootstrap() {
  const [systemLocale, initialLanguagePreference] = await Promise.all([detectSystemLocale(), loadInitialLanguage()]);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <CrystalCutI18nProvider initialSystemLocale={systemLocale} initialLanguagePreference={initialLanguagePreference}>
        <App />
      </CrystalCutI18nProvider>
    </StrictMode>,
  );
}

void bootstrap();
