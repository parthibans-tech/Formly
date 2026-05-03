package officeblank

import (
	"archive/zip"
	"bytes"
	"io"
	"testing"
)

// Each blank must (a) be a syntactically valid zip, (b) carry a
// `[Content_Types].xml` manifest at the root, and (c) include the
// format-specific main part. We don't try to validate XML against the
// full ECMA-376 schema — OnlyOffice's parser is the real downstream
// consumer and is more lenient than xmlschema.
func TestGenerate(t *testing.T) {
	cases := []struct {
		kind     Kind
		mainPart string
		ext      string
	}{
		{KindDocx, "word/document.xml", "docx"},
		{KindXlsx, "xl/workbook.xml", "xlsx"},
		{KindPptx, "ppt/presentation.xml", "pptx"},
	}
	for _, tc := range cases {
		t.Run(string(tc.kind), func(t *testing.T) {
			r, err := Generate(tc.kind)
			if err != nil {
				t.Fatalf("Generate(%s): %v", tc.kind, err)
			}
			if r.Ext != tc.ext {
				t.Errorf("ext: got %q, want %q", r.Ext, tc.ext)
			}
			if r.Mime == "" {
				t.Error("mime empty")
			}
			zr, err := zip.NewReader(bytes.NewReader(r.Bytes), int64(len(r.Bytes)))
			if err != nil {
				t.Fatalf("zip.NewReader: %v", err)
			}
			have := map[string]bool{}
			for _, f := range zr.File {
				have[f.Name] = true
				rc, err := f.Open()
				if err != nil {
					t.Fatalf("open %s: %v", f.Name, err)
				}
				if _, err := io.Copy(io.Discard, rc); err != nil {
					t.Fatalf("read %s: %v", f.Name, err)
				}
				rc.Close()
			}
			if !have["[Content_Types].xml"] {
				t.Error("missing [Content_Types].xml")
			}
			if !have["_rels/.rels"] {
				t.Error("missing _rels/.rels")
			}
			if !have[tc.mainPart] {
				t.Errorf("missing main part %s", tc.mainPart)
			}
		})
	}
}

func TestGenerateUnknown(t *testing.T) {
	if _, err := Generate(Kind("nope")); err == nil {
		t.Error("expected error for unknown kind")
	}
}
