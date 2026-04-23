export type LocaleCode =
  | "en-US"
  | "en-GB"
  | "es-ES"
  | "es-MX"
  | "fr-FR"
  | "de-DE"
  | "pt-BR"
  | "it-IT"
  | "nl-NL"
  | "ja-JP"
  | "zh-CN"
  | "hi-IN"
  | "ar-SA";

export type LocaleOption = { code: LocaleCode; label: string; flag: string };

export const LOCALES: LocaleOption[] = [
  { code: "en-US", label: "English (US)", flag: "🇺🇸" },
  { code: "en-GB", label: "English (UK)", flag: "🇬🇧" },
  { code: "es-ES", label: "Spanish (Spain)", flag: "🇪🇸" },
  { code: "es-MX", label: "Spanish (Mexico)", flag: "🇲🇽" },
  { code: "fr-FR", label: "French", flag: "🇫🇷" },
  { code: "de-DE", label: "German", flag: "🇩🇪" },
  { code: "pt-BR", label: "Portuguese (Brazil)", flag: "🇧🇷" },
  { code: "it-IT", label: "Italian", flag: "🇮🇹" },
  { code: "nl-NL", label: "Dutch", flag: "🇳🇱" },
  { code: "ja-JP", label: "Japanese", flag: "🇯🇵" },
  { code: "zh-CN", label: "Chinese (Simplified)", flag: "🇨🇳" },
  { code: "hi-IN", label: "Hindi", flag: "🇮🇳" },
  { code: "ar-SA", label: "Arabic", flag: "🇸🇦" },
];

export function localeLabel(code: string): string {
  const hit = LOCALES.find((l) => l.code === code);
  return hit ? `${hit.flag} ${hit.label}` : code;
}
