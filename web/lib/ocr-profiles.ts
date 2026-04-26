/**
 * Client-side helpers for the OCR profile picker.
 *
 * Two responsibilities:
 *   1. Fetch the registry of available profiles from /v1/ocr/profiles.
 *      Cached in-module for the page lifetime — the list is stable
 *      (changes only on deploys for now) so re-fetching on every
 *      designer mount would be pure waste.
 *   2. Persist the user's last-picked profile in localStorage so the
 *      next /extract-text call inherits it. Per-browser; we don't
 *      sync this server-side because document types are a personal
 *      workflow preference, not a collaboration artifact.
 *
 * The shape mirrors the JSON the backend returns from
 * `ocrprofiles.Handler.List`. Anything the server doesn't ship (regex
 * bodies, LLM prompts) intentionally never appears here.
 */
import { api } from "@/lib/api";

export interface OcrProfile {
  slug: string;
  name: string;
  description: string;
  icon: string;
  lang?: string;
  psm: number;
  preprocess?: boolean;
  fields?: string[];
  builtin: boolean;
}

const STORAGE_KEY = "formly.ocr.profile";
const DEFAULT_SLUG = "generic";

/** In-memory cache of the profile list. The first caller pays the
 *  network round-trip; everyone else gets the resolved promise so we
 *  don't fan out duplicate /v1/ocr/profiles requests when several
 *  designer mounts open in quick succession. */
let profilesPromise: Promise<OcrProfile[]> | null = null;

/** Fetch the available OCR profiles. Cached for the page lifetime.
 *  Errors are propagated — callers (the designer toolbar) catch and
 *  silently fall back to the default "Generic" entry. */
export function fetchOcrProfiles(): Promise<OcrProfile[]> {
  if (!profilesPromise) {
    profilesPromise = api<{ profiles: OcrProfile[] }>("/v1/ocr/profiles")
      .then((r) => r.profiles ?? [])
      .catch((err) => {
        // Reset the cache so a transient failure (e.g. token expiring
        // mid-request) doesn't lock the picker into "no profiles
        // available" forever.
        profilesPromise = null;
        throw err;
      });
  }
  return profilesPromise;
}

/** Read the user's last-picked profile slug. Falls back to "generic"
 *  on first run / SSR / private-browsing storage failures. */
export function loadPreferredProfileSlug(): string {
  if (typeof window === "undefined") return DEFAULT_SLUG;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : DEFAULT_SLUG;
  } catch {
    return DEFAULT_SLUG;
  }
}

/** Persist the user's chosen profile. No-op when localStorage is
 *  unavailable (private mode in some browsers throws on every set);
 *  the in-memory state in the component still tracks the selection
 *  for the rest of the session. */
export function rememberProfileSlug(slug: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, slug);
  } catch {
    /* private mode / quota — ignore */
  }
}
