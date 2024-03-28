import { render } from "@testing-library/react";
import { TranslationProvider } from "@provider/index";
import { initializeI18n } from "@utils/index";
import { Localize } from "@components/index";

const i18nInstance = initializeI18n({ cdnUrl: "https://localhost:3000" });

describe("Localize component", () => {
  test("test string must be rendered", async () => {
    const { findByText } = render(<Localize i18n_default_text="test" />, {
      wrapper: ({ children }) => (
        <TranslationProvider defaultLang="EN" i18nInstance={i18nInstance}>
          {children}
        </TranslationProvider>
      ),
    });

    expect(await findByText("test")).toBeTruthy();
  });
});
