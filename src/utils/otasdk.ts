import { ModuleType } from "i18next";

interface OtaI18nextModule {
  cdnUrl: string;
  type: ModuleType;
}

type ReadCallback = (err: unknown, val: Record<string, unknown>) => void;

export default class OtaI18next implements OtaI18nextModule {
  type: ModuleType;
  cdnUrl: string;

  constructor(cdnUrl: string) {
    this.type = "backend";
    this.cdnUrl = cdnUrl;
  }

  read(language: string, _namespace: string, callback: ReadCallback) {
    fetch(`${this.cdnUrl}/translations/${language.toLowerCase()}.json`, {
      cache: "no-cache",
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error("Failed to fetch translations");
        }

        return res.json();
      })
      .then((val) => {
        callback(null, val);
      })
      .catch(() => {
        callback(null, {});
      });
  }
}
