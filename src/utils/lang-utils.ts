import { constants } from "@utils/index";

type LanguageCode = keyof typeof constants.ALL_LANGUAGES;

export const getInitialLanguage = () => {
  const url_params = new URLSearchParams(window.location.search);
  const query_lang = url_params.get("lang");
  const local_storage_language = JSON.parse(localStorage.getItem(constants.LANGUAGE_KEY) as string);

  if (query_lang) {
    const query_lang_uppercase = query_lang.toUpperCase();
    localStorage.setItem(constants.LANGUAGE_KEY, JSON.stringify(query_lang_uppercase));
    return query_lang_uppercase;
  }

  if (local_storage_language) {
    return local_storage_language;
  }

  return constants.DEFAULT_LANGUAGE;
};

export const loadIncontextTranslation = (lang: LanguageCode) => {
  const is_ach = lang.toUpperCase() === "ACH";
  if (is_ach) {
    const jipt = document.createElement("script");
    jipt.type = "text/javascript";
    jipt.text = `
            var _jipt = []; _jipt.push(['project', 'deriv-app']);
            var crowdin = document.createElement("script");
            crowdin.setAttribute('src', '//cdn.crowdin.com/jipt/jipt.js');
            document.head.appendChild(crowdin);
        `;
    document.head.appendChild(jipt);
  }
};

/**
 * Filter out unsupported languages and return an Object containing language code and language name
 * @param excludedLanguages
 * @returns Object containing language code and language name
 */
export const getAllowedLanguages = (
  excludedLanguages: Omit<LanguageCode, "ACH">[] = []
) => {
  const unsupportedLanguages = ["ACH", ...excludedLanguages];
  const languageList = Object.keys(constants.ALL_LANGUAGES)
    .filter((key) => !unsupportedLanguages.includes(key))
    .reduce((obj: { [key: string]: string }, key) => {
      obj[key] = constants.ALL_LANGUAGES[key as LanguageCode];
      return obj;
    }, {});

  return languageList;
};
