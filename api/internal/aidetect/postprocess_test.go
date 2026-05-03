package aidetect

import (
	"strings"
	"testing"
)

// TestSlugifyKey covers the label → snake_case identifier transform.
// The cases are organised by the production scenario each one guards
// against — the comments are the spec, the strings are the proof.
func TestSlugifyKey(t *testing.T) {
	cases := []struct {
		name  string
		label string
		want  string
	}{
		// ── happy path: the label is already a clean phrase ──────
		{"plain", "Name", "name"},
		{"two words", "Full Name", "full_name"},
		{"three words", "Date of Birth", "date_of_birth"},

		// ── punctuation that's common in PDF labels ─────────────
		{"colon trailing", "Name:", "name"},
		{"apostrophe", "Applicant's Full Name", "applicants_full_name"},
		{"hyphen", "Co-Applicant", "co_applicant"},
		{"slash", "DD/MM/YYYY", "dd_mm_yyyy"},
		{"parentheses", "Date of Birth (DD/MM/YYYY)", "date_of_birth_dd_mm_yyyy"},
		{"hash sign", "PAN Card #", "pan_card"},
		{"asterisk required", "Email *", "email"},

		// ── number suffixes (Address Line 1/2 etc.) ─────────────
		{"trailing number kept", "Address Line 1", "address_line_1"},
		{"trailing number 2", "Address Line 2", "address_line_2"},

		// ── leading digit guard (JS dot-access compatibility) ──
		{"leading digit", "1st Name", "f_1st_name"},
		{"all digits", "123", "f_123"},

		// ── unicode fold ────────────────────────────────────────
		{"latin accents", "Café Address", "cafe_address"},
		{"latin diacritics", "Naïve Façade", "naive_facade"},

		// ── non-latin scripts drop to empty (caller falls back) ─
		{"devanagari only", "नाम", ""},
		{"chinese only", "姓名", ""},
		{"mixed latin+devanagari keeps latin", "Name नाम", "name"},

		// ── whitespace normalisation ────────────────────────────
		{"leading space", "  Name", "name"},
		{"trailing space", "Name  ", "name"},
		{"interior multi-space", "Full   Name", "full_name"},
		{"tab and newline", "Full\tName\nHere", "full_name_here"},

		// ── empty / whitespace-only input ────────────────────────
		{"empty", "", ""},
		{"whitespace only", "   ", ""},
		{"only punctuation", "---", ""},

		// ── length cap with stopword pruning ─────────────────────
		// Raw slug = "date_of_birth_of_the_primary_account_holder_
		// person_for_kyc_verification" (71 chars > maxSlugLen=64).
		// Tail-walk drops "for" then "the" to land at 63 chars.
		{
			"stopwords drop when over cap",
			"Date of Birth of the Primary Account Holder Person for KYC Verification",
			"date_of_birth_of_primary_account_holder_person_kyc_verification",
		},

		// ── length cap with hard truncation ──────────────────────
		// All meaningful words (no stopwords to drop) → trim from
		// the right at word boundary. Raw input slugs to 70 chars,
		// trim "Pincode" to land at 62.
		{
			"trim trailing words past cap",
			"Applicant Permanent Residential Postal Mailing Correspondence Address Pincode",
			"applicant_permanent_residential_postal_mailing_correspondence",
		},

		// ── camelCase / PascalCase from authored AcroForm names ──
		// Authored intent isn't preserved; we lowercase as the
		// default. The user can rename in the modal if it matters.
		{"PascalCase", "FirstName", "firstname"},
		{"camelCase", "firstName", "firstname"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := slugifyKey(tc.label)
			if got != tc.want {
				t.Errorf("slugifyKey(%q) = %q, want %q", tc.label, got, tc.want)
			}
		})
	}
}

// TestSlugifyKey_LengthCap pins the 40-char hard ceiling. Any future
// change to maxSlugLen needs to update this assertion alongside it.
func TestSlugifyKey_LengthCap(t *testing.T) {
	long := strings.Repeat("supercalifragilisticexpialidocious ", 5)
	got := slugifyKey(long)
	if len(got) > maxSlugLen {
		t.Errorf("slug %q has length %d > maxSlugLen=%d", got, len(got), maxSlugLen)
	}
	if got == "" {
		t.Errorf("slug should not be empty for non-empty input")
	}
}

// TestPolishProposals_NoDuplicates verifies the no-op path — when
// every label is unique, polish only re-slugs the keys; it doesn't
// touch ordering and doesn't append suffixes anywhere.
func TestPolishProposals_NoDuplicates(t *testing.T) {
	props := []Proposal{
		{Page: 1, Label: "First Name", DataKey: "first_name_old"},
		{Page: 1, Label: "Date of Birth", DataKey: "dob"},
		{Page: 2, Label: "Email Address", DataKey: "email"},
	}
	got := polishProposals(props)
	want := []string{"first_name", "date_of_birth", "email_address"}
	for i, p := range got {
		if p.DataKey != want[i] {
			t.Errorf("[%d] DataKey = %q, want %q", i, p.DataKey, want[i])
		}
	}
}

// TestPolishProposals_SamePageDuplicates is the headline scenario the
// user asked about: two "Name" fields on the same page should NOT
// collapse into one. They get suffixed in detection order.
func TestPolishProposals_SamePageDuplicates(t *testing.T) {
	props := []Proposal{
		{Page: 1, Label: "Name", DataKey: "name"},
		{Page: 1, Label: "Address", DataKey: "address"},
		{Page: 1, Label: "Name", DataKey: "name"},
		{Page: 1, Label: "Name", DataKey: "name"},
	}
	got := polishProposals(props)
	wantKeys := []string{"name", "address", "name_2", "name_3"}
	for i, p := range got {
		if p.DataKey != wantKeys[i] {
			t.Errorf("[%d] DataKey = %q, want %q", i, p.DataKey, wantKeys[i])
		}
	}
}

// TestPolishProposals_CrossPageDuplicates covers a multi-page form
// where the same "Signature" label appears on each page. Page suffix
// keeps them addressable per page rather than just numbering them.
func TestPolishProposals_CrossPageDuplicates(t *testing.T) {
	props := []Proposal{
		{Page: 1, Label: "Signature", DataKey: "signature"},
		{Page: 2, Label: "Signature", DataKey: "signature"},
		{Page: 3, Label: "Signature", DataKey: "signature"},
	}
	got := polishProposals(props)
	wantKeys := []string{"signature", "signature_p2", "signature_p3"}
	for i, p := range got {
		if p.DataKey != wantKeys[i] {
			t.Errorf("[%d] DataKey = %q, want %q", i, p.DataKey, wantKeys[i])
		}
	}
}

// TestPolishProposals_MixedSameAndCrossPage layers same-page dupes on
// top of cross-page dupes — e.g. an applicant + co-applicant page each
// containing two "Name" rows. The page suffix should win for the
// later page; per-page numerics should disambiguate within a page.
func TestPolishProposals_MixedSameAndCrossPage(t *testing.T) {
	props := []Proposal{
		{Page: 1, Label: "Name", DataKey: "name"}, // applicant primary
		{Page: 1, Label: "Name", DataKey: "name"}, // applicant alt name
		{Page: 2, Label: "Name", DataKey: "name"}, // co-applicant primary
		{Page: 2, Label: "Name", DataKey: "name"}, // co-applicant alt
	}
	got := polishProposals(props)
	wantKeys := []string{"name", "name_2", "name_p2", "name_p2_2"}
	for i, p := range got {
		if p.DataKey != wantKeys[i] {
			t.Errorf("[%d] DataKey = %q, want %q (full: %+v)", i, p.DataKey, wantKeys[i], got)
		}
	}
}

// TestPolishProposals_PreExistingCollisionAvoided guards the case
// where an unrelated proposal already has key "name_2" — the dedupe
// of a separate "Name" group must skip ahead rather than overwriting
// the unrelated field.
func TestPolishProposals_PreExistingCollisionAvoided(t *testing.T) {
	props := []Proposal{
		{Page: 1, Label: "Name", DataKey: "name"},
		{Page: 1, Label: "Name 2", DataKey: "name_2"}, // pre-existing
		{Page: 1, Label: "Name", DataKey: "name"},     // dupe of first
	}
	got := polishProposals(props)
	// Index 0: "name" wins the bare key.
	// Index 1: "name_2" is the slug of "Name 2" — pre-existing, kept.
	// Index 2: would be "name_2" but that's taken; skips to "name_3".
	wantKeys := []string{"name", "name_2", "name_3"}
	for i, p := range got {
		if p.DataKey != wantKeys[i] {
			t.Errorf("[%d] DataKey = %q, want %q", i, p.DataKey, wantKeys[i])
		}
	}
}

// TestPolishProposals_EmptyLabelKeepsExistingKey verifies the fallback
// path for label-less proposals (bare underlines from heuristic). The
// producer assigned "field_3" or similar; polish must not blank that
// out by replacing it with slugifyKey("") = "".
func TestPolishProposals_EmptyLabelKeepsExistingKey(t *testing.T) {
	props := []Proposal{
		{Page: 1, Label: "", DataKey: "field_1"},
		{Page: 1, Label: "Name", DataKey: "name"},
		{Page: 1, Label: "", DataKey: "field_2"},
	}
	got := polishProposals(props)
	wantKeys := []string{"field_1", "name", "field_2"}
	for i, p := range got {
		if p.DataKey != wantKeys[i] {
			t.Errorf("[%d] DataKey = %q, want %q", i, p.DataKey, wantKeys[i])
		}
	}
}

// TestPolishProposals_Idempotent guards against accidental double-
// processing in the future (e.g. if a refactor calls polish at both
// the producer and the response boundary). Running it twice must
// produce the same output.
func TestPolishProposals_Idempotent(t *testing.T) {
	props := []Proposal{
		{Page: 1, Label: "Name", DataKey: "name"},
		{Page: 1, Label: "Name", DataKey: "name"},
		{Page: 2, Label: "Name", DataKey: "name"},
		{Page: 1, Label: "Date of Birth", DataKey: "dob"},
	}
	once := polishProposals(append([]Proposal(nil), props...))
	twice := polishProposals(append([]Proposal(nil), once...))
	for i := range once {
		if once[i].DataKey != twice[i].DataKey {
			t.Errorf("[%d] not idempotent: once=%q twice=%q",
				i, once[i].DataKey, twice[i].DataKey)
		}
	}
}

// TestPolishProposals_Empty short-circuits cleanly on empty input —
// the cascade's "no fields detected" path passes nil here and we
// must not panic or allocate a sentinel slice.
func TestPolishProposals_Empty(t *testing.T) {
	got := polishProposals(nil)
	if got != nil {
		t.Errorf("polishProposals(nil) = %v, want nil", got)
	}
	got = polishProposals([]Proposal{})
	if len(got) != 0 {
		t.Errorf("polishProposals([]) = %v, want empty", got)
	}
}

// TestNextFreeKey_TakenSetWritethrough ensures the helper updates the
// taken map so a SECOND caller asking for the same base advances past
// the first caller's choice. Without this, two distinct duplicate
// groups whose bases happen to match could both pick the same suffix.
func TestNextFreeKey_TakenSetWritethrough(t *testing.T) {
	taken := map[string]bool{"name": true}
	first := nextFreeKey("name", 2, taken)
	if first != "name_2" {
		t.Fatalf("first call = %q, want \"name_2\"", first)
	}
	second := nextFreeKey("name", 2, taken)
	if second != "name_3" {
		t.Errorf("second call = %q, want \"name_3\" (taken set must include first)", second)
	}
}
