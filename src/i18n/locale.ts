import { locale as tauriLocale } from "@tauri-apps/plugin-os";

export const SUPPORTED_LOCALES = ["ko", "en", "ja", "zh-CN", "zh-TW", "es", "de", "fr", "pt-BR"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type LanguagePreference = "system" | SupportedLocale;

export interface LocaleOption {
  value: SupportedLocale;
  nativeName: string;
}

export const LOCALE_OPTIONS: LocaleOption[] = [
  { value: "ko", nativeName: "한국어" },
  { value: "en", nativeName: "English" },
  { value: "ja", nativeName: "日本語" },
  { value: "zh-CN", nativeName: "简体中文" },
  { value: "zh-TW", nativeName: "繁體中文" },
  { value: "es", nativeName: "Español" },
  { value: "de", nativeName: "Deutsch" },
  { value: "fr", nativeName: "Français" },
  { value: "pt-BR", nativeName: "Português (Brasil)" },
];

const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

export function canonicalizeLocale(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

export function resolveSupportedLocale(value: string | null | undefined): SupportedLocale {
  const canonical = canonicalizeLocale(value);
  if (!canonical) return "en";
  const lower = canonical.toLowerCase();
  if (lower === "zh" || lower.startsWith("zh-hans") || lower.startsWith("zh-cn") || lower.startsWith("zh-sg")) return "zh-CN";
  if (lower.startsWith("zh-hant") || lower.startsWith("zh-tw") || lower.startsWith("zh-hk") || lower.startsWith("zh-mo")) return "zh-TW";
  if (lower.startsWith("pt-br")) return "pt-BR";
  const language = lower.split("-")[0];
  return SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === language) ?? "en";
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || SUPPORTED_LOCALES.includes(value as SupportedLocale);
}

export async function detectSystemLocale(): Promise<string> {
  if (isTauri()) {
    try {
      const detected = canonicalizeLocale(await tauriLocale());
      if (detected) return detected;
    } catch {
      // Browser preferences remain a safe fallback if the OS plugin is unavailable.
    }
  }
  for (const language of navigator.languages ?? []) {
    const detected = canonicalizeLocale(language);
    if (detected) return detected;
  }
  return canonicalizeLocale(navigator.language) ?? "en";
}

export function localeDirection(_locale: SupportedLocale): "ltr" | "rtl" {
  // The first release contains LTR languages. Centralized for future RTL catalogs.
  return "ltr";
}
