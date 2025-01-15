// This must be a union of all literals in the array `i18n.locales` in astro.config.mjs
// Otherwise, `undefined` could be returned in `useTranslations`, as `Astro.currentLocale`
// is used to index a dictionary (`Multilingual`) with these keys.
export type Locale = "en" | "he";

export type Multilingual = { [key in Locale]: string };

export function useTranslations(lang: Locale) {
  return function t(multilingual: Multilingual): string {
    return multilingual[lang];
  };
}

export const Locales: Locale[] = ["en", "he"];
