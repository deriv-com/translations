import { useEffect, useState } from "react";
import { TranslationProvider, initializeI18n } from "@/index";

import Playground from "./Playground";

const languages = [
  "ACH",
  "AR",
  "BN",
  "DE",
  "EN",
  "ES",
  "FR",
  "ID",
  "IT",
  "TA",
  "KO",
  "PL",
  "PT",
  "RU",
  "SI",
  "TH",
  "TR",
  "VI",
  "ZH_CN",
  "ZH_TW",
];

const cdnUrl = localStorage.getItem("cdnUrl") || "";

const i18next = initializeI18n({
  cdnUrl,
});

export default function PlaygroundContainer() {
  const [translationData, setTranslationData] = useState<
    Record<string, string>
  >({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchTranslations = async () => {
      const data = await Promise.all(
        languages.map((lang) =>
          fetch(cdnUrl + `/translations/${lang.toLowerCase()}.json`)
            .then((res) => res.json())
            .catch(() => ({}))
        )
      );

      const translations = data.reduce((acc, curr, index) => {
        acc[languages[index]] = curr;
        return acc;
      }, {});

      setTranslationData(translations);
      setIsLoading(false);
    };

    fetchTranslations();
  }, []);

  return (
    <TranslationProvider defaultLang="EN" i18nInstance={i18next}>
      <Playground
        isLoading={isLoading}
        translationData={translationData}
        languages={languages}
      />
    </TranslationProvider>
  );
}
