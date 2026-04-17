"use client";

import { useTranslation } from "react-i18next";
import { useContext } from "react";
import { TranslationContext } from "@/provider/index";
import { str as crc32 } from "crc-32";

export default function useTranslations() {
  const instanceValue = useContext(TranslationContext);
  const { ready, t, i18n } = useTranslation();

  const localize = (tString: string, values: Record<string, unknown> = {}) =>
    t(crc32(tString).toString(), { defaultValue: tString, ...values });

  if (!instanceValue) {
    throw new Error(
      "useTranslation has to be used within <TranslationContext.Provider>"
    );
  }

  return {
    ready,
    localize,
    instance: i18n,
    switchLanguage: instanceValue.switchLanguage,
    currentLang: instanceValue.currentLang,
  };
}
