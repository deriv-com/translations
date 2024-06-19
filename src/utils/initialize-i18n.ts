import i18next, { InitOptions } from "i18next";
import { str as crc32 } from "crc-32";
import { OtaSdk } from "@utils/index";
import { initReactI18next } from "react-i18next";
import { getInitialLanguage } from "@utils/index";

type TInstanceConfig = {
  useSuspense?: Exclude<InitOptions["react"], undefined>["useSuspense"];
  enableDebug?: InitOptions["debug"];
};

const setI18Config = ({
  useSuspense,
  enableDebug,
}: TInstanceConfig): InitOptions => ({
  load: "languageOnly",
  react: {
    hashTransKey(defaultValue: string) {
      return crc32(defaultValue);
    },
    useSuspense,
  },
  debug: enableDebug,
  initImmediate: true,
  fallbackLng: "EN",
  interpolation: {
    escapeValue: false,
  },
});

export default function initializeI18n({
  cdnUrl,
  useSuspense = true,
  enableDebug = false,
}: {
  cdnUrl: string;
} & TInstanceConfig) {
  const module = new OtaSdk(cdnUrl);

  const initial_language = getInitialLanguage();

  const i18n_config = setI18Config({ useSuspense, enableDebug });

  i18next
    .use(module)
    .use(initReactI18next)
    .init({ ...i18n_config, lng: initial_language });

  return i18next;
}
