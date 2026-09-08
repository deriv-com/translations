import "@testing-library/jest-dom";

const mockTranslationValues = {
  "/translations/es.json": {
    "-662733300": "es test",
  },
  "/translations/en.json": {
    "-662733300": "en test",
  },
  "/translations/ko.json": {
    "-662733300": "ko test",
  },
  "/translations/zh_cn.json": {
    "-662733300": "zh-cn test",
  },
} as const;

// @ts-expect-error - fetch is a global function
global.fetch = vi.fn((lng: keyof typeof mockTranslationValues) =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve(mockTranslationValues[lng]),
  })
);
