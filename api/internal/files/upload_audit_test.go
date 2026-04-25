package files

import "testing"

// TestBuildUploadCompletedMeta locks the wire shape of the
// "file.upload.completed" audit row's JSON payload. Forensic tooling
// (the settings/audit UI, log-replay scripts, SIEM exports) keys off
// these field names; renaming or dropping one would break log review
// silently because the meta column is JSONB and Postgres won't enforce
// the schema. The test is the only thing that does.
//
// The set of required keys mirrors the original audit-gap report:
// (user, IP, UA, fileID, claimed mime, actual size). user/IP/UA come
// from audit.FromRequest at the LogHTTP layer; the rest land here.
func TestBuildUploadCompletedMeta(t *testing.T) {
	t.Run("scan-disabled path", func(t *testing.T) {
		m := buildUploadCompletedMeta("file-123", "report.pdf", "application/pdf", 4096, false, "")
		// Required keys for forensic reconstruction.
		mustEq(t, m, "fileId", "file-123")
		mustEq(t, m, "name", "report.pdf")
		mustEq(t, m, "actualMime", "application/pdf")
		mustEq(t, m, "actualSize", int64(4096))
		mustEq(t, m, "scanEnabled", false)
		// Off path must record "skipped" (not empty / not "pending"); the
		// audit UI uses this to render the green "no AV configured" badge.
		mustEq(t, m, "scanStatus", "skipped")
		// templateId is omitted when no detector ran — keeps the audit row
		// terse and machine-friendly (jq filters use `has("templateId")`).
		if _, ok := m["templateId"]; ok {
			t.Errorf("scan-disabled meta should omit templateId, got %v", m["templateId"])
		}
	})

	t.Run("scan-enabled path", func(t *testing.T) {
		m := buildUploadCompletedMeta("file-456", "doc.pdf", "application/pdf", 12345, true, "")
		mustEq(t, m, "scanEnabled", true)
		// Critical: when the AV worker is going to scan, the row records
		// "pending" — NOT "skipped". A future refactor that flipped this
		// to "skipped" would silently mark every infected file as
		// "we didn't even try" in the audit trail.
		mustEq(t, m, "scanStatus", "pending")
	})

	t.Run("template-detected path", func(t *testing.T) {
		m := buildUploadCompletedMeta("file-789", "form.pdf", "application/pdf", 99, false, "tpl-abc")
		mustEq(t, m, "templateId", "tpl-abc")
	})

	t.Run("size is int64 not int", func(t *testing.T) {
		// JSON marshalling treats both fine, but the audit UI's TypeScript
		// definition expects a number that can hold > 2^31 (2 GiB+ uploads
		// are valid for paid plans). Lock the wire type so a refactor to
		// `int` doesn't silently truncate at 2 GiB on 32-bit builds.
		m := buildUploadCompletedMeta("f", "n", "m", 1<<40, false, "")
		if _, ok := m["actualSize"].(int64); !ok {
			t.Errorf("actualSize must be int64, got %T", m["actualSize"])
		}
	})
}

func mustEq(t *testing.T, m map[string]any, key string, want any) {
	t.Helper()
	got, ok := m[key]
	if !ok {
		t.Errorf("meta missing required key %q (have keys: %v)", key, mapKeys(m))
		return
	}
	if got != want {
		t.Errorf("meta[%q] = %v (%T), want %v (%T)", key, got, got, want, want)
	}
}

func mapKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
