package aidetect

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestDetectResp_NilProposalsMarshalsAsEmptyArray pins the wire shape
// the frontend modal depends on. Without the custom MarshalJSON, a
// nil Proposals slice would serialize to `"proposals":null`, and the
// modal's .forEach / .map calls would crash with a TypeError.
//
// This is the bug we hit in production after adding the cascade's
// "no fields detected" paths — the regression here would silently
// reappear if a future contributor adds another detectResp construction
// site that forgets to initialise Proposals.
func TestDetectResp_NilProposalsMarshalsAsEmptyArray(t *testing.T) {
	r := detectResp{
		Source:  "none",
		Count:   0,
		Message: "Nothing found",
		// Proposals intentionally left nil — this is the regression case.
	}
	got, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	gotStr := string(got)
	if !strings.Contains(gotStr, `"proposals":[]`) {
		t.Errorf("nil Proposals serialized to %s, want `\"proposals\":[]` (not null)", gotStr)
	}
	if strings.Contains(gotStr, `"proposals":null`) {
		t.Errorf("Proposals leaked as null: %s", gotStr)
	}
}

func TestDetectResp_NonEmptyProposalsMarshalUnchanged(t *testing.T) {
	r := detectResp{
		Source: "vision",
		Count:  1,
		Proposals: []Proposal{
			{Type: "text", Page: 1, X: 10, Y: 20, W: 100, H: 12, DataKey: "name", Source: "vision", Confidence: 0.7},
		},
	}
	got, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	// Round-trip back so the test isn't tied to field ordering.
	var rt detectResp
	if err := json.Unmarshal(got, &rt); err != nil {
		t.Fatalf("Unmarshal: %v\nbody: %s", err, got)
	}
	if rt.Source != "vision" || rt.Count != 1 || len(rt.Proposals) != 1 {
		t.Errorf("round-trip mismatch: %+v", rt)
	}
	if rt.Proposals[0].DataKey != "name" {
		t.Errorf("Proposals[0].DataKey = %q, want \"name\"", rt.Proposals[0].DataKey)
	}
}
