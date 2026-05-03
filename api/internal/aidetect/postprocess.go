package aidetect

// postprocess.go runs the LAST polishing pass before proposals leave
// the cascade and hit the wire. It exists because the three detection
// tiers (acroform / heuristic / vision) all produce raw `DataKey`
// values directly from whatever string they had on hand:
//
//   - acroform: the PDF widget's /T name, often verbatim "Applicant
//               Name" with the space preserved
//   - heuristic: the OCR'd label text from the nearest line, e.g.
//                "Date of Birth (DD/MM/YYYY)"
//   - vision:    whatever the LLM emitted in `label`, which is even
//                less constrained — variations in casing, punctuation,
//                and trailing colons are all common
//
// Without normalisation the integrator gets keys like
// "Applicant Name", "Applicant_Name", "applicantName", "applicant
// name (full)" — all referring to the same logical field. The
// designer modal shows them as separate rows, the JSON payload they
// publish has noisy, unstable keys, and downstream systems that key
// off the data shape break on every re-detection.
//
// This pass converges all three tiers on the same key shape:
//
//   1. ASCII-fold + lowercase + collapse non-alphanumeric runs to `_`
//      so "Applicant's Full Name" → "applicants_full_name" and
//      "Date of Birth" → "date_of_birth" regardless of source tier
//   2. Cap length at 40 chars, trimmed at a word boundary, so a
//      verbose vision-emitted label doesn't produce an unwieldy key
//   3. Disambiguate true duplicates within the proposal set:
//      same key + same page → suffix "_2", "_3", ...
//      same key + different pages → suffix "_p<page>"
//
// Why post-process instead of fixing each tier in place: we get to
// see the FULL proposal set before assigning suffixes, so the dedupe
// is correct across tier boundaries (e.g. a vision-detected field
// that happens to share its label with an AcroForm-detected field
// on a different page gets a stable `_p2` suffix instead of an
// arbitrary numeric one). It also means future tiers (form-template
// reuse, integrator-specific schema mapping) only need to slot in
// here, not change every detector.

import (
	"fmt"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// maxSlugLen caps the slug length. JSON keys have no formal limit
// but integrator schemas (column names, form-builder field IDs) do —
// 64 matches MySQL/Postgres's identifier cap and is the longest a
// no-code form-builder will accept. The previous 40-char ceiling
// truncated context-qualified labels ("mailing_address_company_name_
// flat_no_bldg_name" = 46 chars) and produced ambiguous keys; 64
// gives section-prefixed slugs room to stay readable while still
// fitting downstream integrator constraints. Disambiguation suffixes
// (`_2`, `_p3`) come on top — uniqueKey will exceed the cap when it
// has to (correctness over length).
const maxSlugLen = 64

// stopwords removed from slugs when their inclusion would push the
// slug past the length cap. We don't blanket-strip these because
// "Date of Birth" → "date_birth" is uglier than "date_of_birth";
// only drop when we have to.
var stopwords = map[string]bool{
	"a": true, "an": true, "and": true, "for": true, "in": true,
	"of": true, "on": true, "or": true, "the": true, "to": true,
	"with": true,
}

// slugifyKey turns an arbitrary label string into a clean snake_case
// identifier suitable for a JSON key, form-builder field ID, or DB
// column name. Empty input → empty string; the caller then assigns a
// synthetic "field_N" key.
//
// Examples (also unit-tested):
//
//	"Applicant's Full Name"         → "applicants_full_name"
//	"Date of Birth (DD/MM/YYYY)"    → "date_of_birth_dd_mm_yyyy"
//	"PAN Card #"                    → "pan_card"
//	"Co-Applicant"                  → "co_applicant"
//	"Address Line 1"                → "address_line_1"
//	"123 ABC"                       → "f_123_abc"  (leading digit guard)
//	"नाम" (Devanagari)              → "name"        (transliteration not
//	                                                 attempted — non-latin
//	                                                 scripts get dropped by
//	                                                 the fold; caller falls
//	                                                 back to field_N)
//
// The leading-digit guard exists because many integrators feed these
// keys into JS dot-notation (`data.address_line_1` is fine but
// `data.1_address` is a syntax error). We prefix `f_` rather than
// stripping the digit so "Address Line 1" stays meaningfully distinct
// from "Address Line 2".
func slugifyKey(label string) string {
	if label == "" {
		return ""
	}

	// Step 1: ASCII-fold. NFD decomposes "é" → "e" + combining acute,
	// then runes.Remove(Mn) drops the combining mark. Anything outside
	// ASCII after the fold (CJK, Devanagari, ...) gets dropped in step
	// 2's character filter — we don't try to romanize because the
	// transliteration tables would balloon the binary and the result
	// is rarely what a non-latin-script user wants for an integrator
	// key anyway. Those callers fall back to field_N.
	folded, _, err := transform.String(
		transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC),
		label,
	)
	if err != nil {
		// transform never fails for in-memory strings, but be defensive.
		folded = label
	}

	// Step 2: walk runes, keep [a-z0-9], replace everything else with
	// `_`, lowercase as we go. Doing it in one pass is cheaper than
	// strings.ToLower + regex.ReplaceAllString and gives us tighter
	// control over edge cases (consecutive separators collapse).
	//
	// Apostrophes (straight ', curly ’, backtick `) are special-cased:
	// we drop them WITHOUT inserting a separator, so "Applicant's" →
	// "applicants" not "applicant_s". They're typographic, not
	// semantic — splitting on them produces meaningless one-letter
	// tokens that bloat the key.
	var b strings.Builder
	b.Grow(len(folded))
	prevSep := true // start "in a separator state" so leading `_` is suppressed
	for _, r := range folded {
		switch {
		case r == '\'' || r == '\u2019' || r == '`':
			// Strip without inserting a separator. prevSep stays
			// whatever it was before the apostrophe.
			continue
		case r >= 'A' && r <= 'Z':
			b.WriteRune(r + ('a' - 'A'))
			prevSep = false
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevSep = false
		default:
			if !prevSep {
				b.WriteByte('_')
				prevSep = true
			}
		}
	}
	slug := strings.TrimRight(b.String(), "_")
	if slug == "" {
		return ""
	}

	// Step 3: word-aware length trim. Splitting on `_` lets us keep
	// whole semantic words rather than chopping mid-word. We drop
	// stopwords first (only if needed), then trim trailing words.
	if len(slug) > maxSlugLen {
		words := strings.Split(slug, "_")
		// First pass: drop stopwords from the tail until under cap.
		// We iterate from the end because trailing qualifiers ("of
		// the borrower") are usually less load-bearing than head
		// nouns ("date of birth" — we'd rather keep "date" than "of
		// the borrower").
		for i := len(words) - 1; i >= 0 && joinedLen(words) > maxSlugLen; i-- {
			if stopwords[words[i]] {
				words = append(words[:i], words[i+1:]...)
			}
		}
		// Second pass: still too long? Drop trailing words.
		for joinedLen(words) > maxSlugLen && len(words) > 1 {
			words = words[:len(words)-1]
		}
		slug = strings.Join(words, "_")
		// Final hard cap in case a single word is itself > maxSlugLen.
		if len(slug) > maxSlugLen {
			slug = slug[:maxSlugLen]
			slug = strings.TrimRight(slug, "_")
		}
	}

	// Step 4: leading-digit guard. JSON allows it; JS dot-access and
	// most form-builder schemas don't.
	if slug != "" && slug[0] >= '0' && slug[0] <= '9' {
		slug = "f_" + slug
		if len(slug) > maxSlugLen {
			slug = slug[:maxSlugLen]
			slug = strings.TrimRight(slug, "_")
		}
	}

	return slug
}

func joinedLen(words []string) int {
	if len(words) == 0 {
		return 0
	}
	n := len(words) - 1 // separators
	for _, w := range words {
		n += len(w)
	}
	return n
}

// polishProposals re-derives clean DataKeys from labels and
// disambiguates duplicates across the full proposal set. Idempotent:
// running it twice produces the same result.
//
// The order of proposals is preserved — the modal renders them in
// detection order (top-to-bottom on each page), and the dedupe
// suffixing assumes the FIRST occurrence keeps the bare key while
// subsequent ones get suffixed. That matches author intuition: the
// "Name" field at the top of an applicant section gets `name`, the
// one in the co-applicant section below gets `name_2`.
func polishProposals(proposals []Proposal) []Proposal {
	if len(proposals) == 0 {
		return proposals
	}

	// Pass 1: re-slug every key from its label. Falls back to the
	// existing DataKey (which is already at-worst a `field_N`
	// synthetic) when slugifyKey returns empty — so a label-less
	// proposal doesn't get renamed to "".
	for i := range proposals {
		slug := slugifyKey(proposals[i].Label)
		if slug == "" {
			// Existing key (which the producer set, often "field_N"
			// or a sanitized AcroForm name) is fine — leave it.
			continue
		}
		proposals[i].DataKey = slug
	}

	// Pass 2: find duplicate keys and disambiguate. We index occurrences
	// per key so we can decide between page-suffix and numeric-suffix
	// strategies based on whether the duplicates straddle pages.
	type occ struct {
		idx  int // index into proposals
		page int
	}
	groups := map[string][]occ{}
	for i, p := range proposals {
		groups[p.DataKey] = append(groups[p.DataKey], occ{idx: i, page: p.Page})
	}

	// `taken` tracks every key currently in use, including ones we
	// assign during disambiguation. Starts with the original key set
	// so a fresh suffix can never collide with an unrelated existing
	// group ("name_2" already exists from the source data → renaming
	// the second "name" must skip to "name_3"). uniqueKey reads AND
	// writes this set so siblings within the same group also stay
	// distinct from each other.
	taken := make(map[string]bool, len(groups))
	for k := range groups {
		taken[k] = true
	}

	// Sort group keys so iteration is deterministic — the dedupe order
	// matters for the rare case where two distinct labels both slug to
	// the same key AND both already collide with another. Without
	// sorting, map iteration randomness would shuffle who wins the
	// bare key vs which one gets the suffix.
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, key := range keys {
		occs := groups[key]
		if len(occs) < 2 {
			continue
		}
		// Stable order within the group: by page, then by document
		// position (idx is detection order, which is top-to-bottom).
		sort.SliceStable(occs, func(i, j int) bool {
			if occs[i].page != occs[j].page {
				return occs[i].page < occs[j].page
			}
			return occs[i].idx < occs[j].idx
		})

		// Does this group straddle pages? Multi-page duplicates use a
		// `_p<N>` suffix scheme so the integrator can tell which page
		// the field came from; single-page duplicates use bare numeric
		// suffixes since the page tag would be redundant.
		multiPage := false
		for i := 1; i < len(occs); i++ {
			if occs[i].page != occs[0].page {
				multiPage = true
				break
			}
		}

		if multiPage {
			seenPage := map[int]int{}
			for _, o := range occs {
				seenPage[o.page]++
				if o.page == occs[0].page {
					// First page: first occurrence keeps the bare key,
					// per-page collisions on it get numeric suffixes.
					if seenPage[o.page] > 1 {
						proposals[o.idx].DataKey = nextFreeKey(key, seenPage[o.page], taken)
					}
					continue
				}
				// Later page: `_p<page>` base, plus per-page numeric
				// when the page itself has multiple of this key.
				base := fmt.Sprintf("%s_p%d", key, o.page)
				n := 0
				if seenPage[o.page] > 1 {
					n = seenPage[o.page]
				}
				proposals[o.idx].DataKey = nextFreeKey(base, n, taken)
			}
			continue
		}

		// Single-page duplicates: first occurrence keeps the bare key,
		// the rest get `_2`, `_3`, ...
		for n, o := range occs {
			if n == 0 {
				continue
			}
			proposals[o.idx].DataKey = nextFreeKey(key, n+1, taken)
		}
	}

	// Pass 3: label-semantic enrichment. Runs AFTER slugging+dedupe so
	// applySemantics sees both the final Label and the final DataKey
	// (the latter matters for tier outputs that ship empty labels but
	// snake_case keys — "pan_number" still triggers the PAN rule). All
	// three tiers funnel through here so this single call site enriches
	// acroform / heuristic / vision proposals uniformly.
	for i := range proposals {
		applySemantics(&proposals[i])
	}

	return proposals
}

// nextFreeKey returns the first un-`taken` key formed by appending
// `_<n>` to base (or just base when n==0), bumping n on collision
// until clear. The chosen key is added to `taken` so subsequent calls
// skip it.
//
// This is O(k) where k is the number of suffixes tried — bounded by
// the number of duplicates, which forms in practice cap at <10. The
// `taken` lookup is O(1) so the inner loop is cheap.
func nextFreeKey(base string, n int, taken map[string]bool) string {
	candidate := base
	if n > 0 {
		candidate = fmt.Sprintf("%s_%d", base, n)
	}
	for taken[candidate] {
		n++
		candidate = fmt.Sprintf("%s_%d", base, n)
	}
	taken[candidate] = true
	return candidate
}
