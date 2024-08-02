import { str as crc32 } from "crc-32";
import i18next from "i18next";

export default function localize(
  string: string,
  values?: Record<string, unknown>
) {
  if (!string) return "";

  return i18next.t(crc32(string).toString(), {
    defaultValue: string,
    ...values,
  });
}
