"use client";

import type { i18n } from "i18next";
import React from "react";
import { Trans, withTranslation } from "react-i18next";

type TLocalizeProps = {
  i18n_default_text: string;
  values?: object;
  components?: React.JSX.Element[];
  options?: Record<string, unknown>;
  shouldUnescape?: boolean;
  i18n?: i18n;
};

function LocalizeComponent({
  i18n,
  i18n_default_text,
  values,
  components,
  options,
  shouldUnescape,
}: TLocalizeProps) {
  return (
    <Trans
      defaults={i18n_default_text}
      i18n={i18n}
      values={values}
      components={components}
      tOptions={options}
      shouldUnescape={shouldUnescape}
    />
  );
}

const Localize: React.ComponentType<TLocalizeProps> =
  withTranslation()(LocalizeComponent);

export default Localize;
