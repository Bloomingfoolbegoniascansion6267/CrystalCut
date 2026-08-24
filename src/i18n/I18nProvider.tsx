import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { IntlProvider, useIntl } from "react-intl";
import { en, ko } from "./messages";
import { LanguagePreference, localeDirection, resolveSupportedLocale, SupportedLocale } from "./locale";

type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;

type ForeignCatalogs = typeof import("./translations");

const foreignCatalogFor = (catalogs: ForeignCatalogs | null, locale: SupportedLocale) => {
  if (!catalogs) return null;
  if (locale === "ja") return catalogs.ja;
  if (locale === "zh-CN") return catalogs.zhCN;
  if (locale === "zh-TW") return catalogs.zhTW;
  if (locale === "es") return catalogs.es;
  if (locale === "de") return catalogs.de;
  if (locale === "fr") return catalogs.fr;
  if (locale === "pt-BR") return catalogs.ptBR;
  return null;
};

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
  const [foreignCatalogs, setForeignCatalogs] = useState<ForeignCatalogs | null>(null);
  const locale = languagePreference === "system" ? resolveSupportedLocale(systemLocale) : languagePreference;
  const formatLocale = languagePreference === "system" ? systemLocale : languagePreference;
  const needsForeignCatalog = locale !== "en" && locale !== "ko";
  const messages = useMemo(() => ({
    ...en,
    ...(locale === "ko" ? ko : foreignCatalogFor(foreignCatalogs, locale) ?? en),
  }), [foreignCatalogs, locale]);

  useEffect(() => {
    if (!needsForeignCatalog || foreignCatalogs) return;
    let disposed = false;
    void import("./translations").then((catalogs) => {
      if (!disposed) setForeignCatalogs(catalogs);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [foreignCatalogs, needsForeignCatalog]);

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
