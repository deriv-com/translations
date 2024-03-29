import { constants } from "@utils/index";

export const getInitialLanguage = () => {
  const url_params = new URLSearchParams(window.location.search);
  const query_lang = url_params.get("lang");
  const local_storage_language = localStorage.getItem(constants.LANGUAGE_KEY);

  if (query_lang) {
    const query_lang_uppercase = query_lang.toUpperCase();
    localStorage.setItem(constants.LANGUAGE_KEY, query_lang_uppercase);
    return query_lang_uppercase;
  }

  if (local_storage_language) {
    return local_storage_language;
  }

  return constants.DEFAULT_LANGUAGE;
};

export const loadIncontextTranslation = (
  lang: keyof typeof constants.ALL_LANGUAGES
) => {
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
