// UI language ("en" or "ja"). The shell passes it in the page URL (?lang=ja) and
// sends a "lang" message when the user switches it. Anything else means English.
let lang = "en";
if (typeof location !== "undefined") {
  lang = new URLSearchParams(location.search).get("lang") === "ja" ? "ja" : "en";
}
if (typeof document !== "undefined") document.documentElement.lang = lang;

// Pick the string for the current language.
export function tr(en, ja) {
  return lang === "ja" ? ja : en;
}

export function setLang(value) {
  lang = value === "ja" ? "ja" : "en";
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}
