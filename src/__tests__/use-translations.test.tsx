import { act, waitFor } from "@testing-library/react/pure";
import { useTranslations } from "@/index";
import { customRenderHook } from "@test-utils/index";

describe("useTranslations hook", () => {
  test("localize function from useTranslations hook must work fine", async () => {
    const { result } = customRenderHook(() => useTranslations());

    await waitFor(() => result.current.localize);
    expect(result.current.localize("test")).toBe("en test");
  });

  test("switching of the language must work fine", async () => {
    const { result } = customRenderHook(() => useTranslations());

    await waitFor(() => result.current.localize);
    expect(result.current.currentLang).toBe("EN");

    await act(() => {
      result.current.switchLanguage("ES");
    });
    expect(result.current.currentLang).toBe("ES");
    expect(result.current.localize("test")).toBe("es test");

    await act(() => {
      result.current.switchLanguage("KO");
    });
    expect(result.current.currentLang).toBe("KO");
    expect(result.current.localize("test")).toBe("ko test");
  });

  test("does not load the base language for ZH_CN", async () => {
    const { result } = customRenderHook(() => useTranslations());
    await waitFor(() => result.current.switchLanguage);
    vi.mocked(fetch).mockClear();

    await act(() => {
      result.current.switchLanguage("ZH_CN");
    });

    await waitFor(() =>
      expect(result.current.localize("test")).toBe("zh-cn test")
    );
    expect(fetch).toHaveBeenCalledWith("/translations/zh_cn.json");
    expect(fetch).not.toHaveBeenCalledWith("/translations/zh.json");
  });
});
