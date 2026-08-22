import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { IntlProvider, useIntl } from "react-intl";
import { en, ko } from "./messages";
import { de, es, fr, ja, ptBR, zhCN, zhTW } from "./translations";
import { LanguagePreference, localeDirection, resolveSupportedLocale, SupportedLocale } from "./locale";

type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;

const catalogs = { en, ko, ja, "zh-CN": zhCN, "zh-TW": zhTW, es, de, fr, "pt-BR": ptBR } as const;

interface LocaleContextValue {
  languagePreference: LanguagePreference;
  locale: SupportedLocale;
  formatLocale: string;
  systemLocale: string;
  setLanguagePreference: (preference: LanguagePreference) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function CrystalCutI18nProvider({ initialSystemLocale, initialLanguagePreference = "system", children }: { initialSystemLocale: string; initialLanguagePreference?: LanguagePreference; children: ReactNode }) {
  const [systemLocale] = useState(initialSystemLocale);
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(initialLanguagePreference);
  const locale = languagePreference === "system" ? resolveSupportedLocale(systemLocale) : languagePreference;
  const formatLocale = languagePreference === "system" ? systemLocale : languagePreference;
  const messages = useMemo(() => ({ ...en, ...catalogs[locale] }), [locale]);

  useEffect(() => {
    document.documentElement.lang = formatLocale;
    document.documentElement.dir = localeDirection(locale);
    document.title = "CrystalCut";
  }, [formatLocale, locale]);

  const value = useMemo(() => ({ languagePreference, locale, formatLocale, systemLocale, setLanguagePreference }), [formatLocale, languagePreference, locale, systemLocale]);
  return <LocaleContext.Provider value={value}><IntlProvider locale={formatLocale} defaultLocale="en" messages={messages}>{children}</IntlProvider></LocaleContext.Provider>;
}

export function useI18n() {
  const context = useContext(LocaleContext);
  const intl = useIntl();
  if (!context) throw new Error("useI18n must be used inside CrystalCutI18nProvider");
  const t = useCallback((id: string, values?: MessageValues) => intl.formatMessage({ id, defaultMessage: en[id] ?? id }, values), [intl]);
  return { ...context, t, formatNumber: intl.formatNumber, formatDate: intl.formatDate, formatTime: intl.formatTime };
}
