import { createContext, useEffect, useState } from "react";
import { I18nextProvider } from "react-i18next";

import { constants } from "@utils/index";

import type { i18n as Ti18n } from "i18next";

export const TranslationContext = createContext<{
  currentLang: string;
  switchLanguage: (lang: string) => void;
} | null>(null);

export default function TranslationProvider({
  defaultLang,
  i18nInstance,
  children,
}: {
  defaultLang?: keyof Omit<typeof constants.ALL_LANGUAGES, "ACH">;
  i18nInstance: Ti18n;
  children: React.ReactNode;
}) {
  const [currentLanguage, setCurrentLanguage] = useState(defaultLang || "");
  const [isTranslationsLoaded, setIsTranslationsLoaded] = useState(false);

  const switchLanguage = (lang: string) => {
    i18nInstance.changeLanguage(lang);
    setCurrentLanguage(lang);
    localStorage.setItem(constants.LANGUAGE_KEY, JSON.stringify(lang));
  };

  useEffect(() => {
    if (i18nInstance) {
      const initialLang = i18nInstance.language || defaultLang || "";
      setCurrentLanguage(initialLang);
      setIsTranslationsLoaded(true);
    }
  }, [i18nInstance, defaultLang]);

  if (!i18nInstance || !isTranslationsLoaded) return null;

  return (
    <I18nextProvider i18n={i18nInstance}>
      <TranslationContext.Provider
        value={{
          currentLang: currentLanguage,
          switchLanguage,
        }}
      >
        {children}
      </TranslationContext.Provider>
    </I18nextProvider>
  );
}
