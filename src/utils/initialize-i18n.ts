import i18next from "i18next";
import { str as crc32 } from "crc-32";
import { OtaSdk } from "@utils/index";
import { initReactI18next } from "react-i18next";
import { getInitialLanguage } from "@utils/index";
import LanguageDetector from "i18next-browser-languagedetector";

const i18n_config = {
  react: {
    hashTransKey(defaultValue: string) {
      return crc32(defaultValue);
    },
    useSuspense: true,
  },
  debug: false,
  initImmediate: true,
  fallbackLng: "en",
  interpolation: {
    escapeValue: false,
  },
};

export default function initializeI18n({ cdnUrl }: { cdnUrl: string }) {
  const module = new OtaSdk(cdnUrl);

  const initial_language = getInitialLanguage();

  i18next
    .use(module)
    .use(initReactI18next)
    .use(LanguageDetector)
    .init({ ...i18n_config, lng: initial_language });

  return i18next;
}
