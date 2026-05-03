// Package officeblank generates the minimal byte-stream of a valid empty
// OOXML document — Word (.docx), Excel (.xlsx), or PowerPoint (.pptx) —
// using only the standard library.
//
// Why this exists: the Drive UI lets users create a new "blank Word" /
// "blank Excel" / "blank PowerPoint" doc that opens straight in the
// OnlyOffice editor. OnlyOffice can edit existing OOXML but won't
// fabricate an empty file from nothing — somebody has to upload bytes
// first. Rather than ship binary fixtures (which would need to live in
// the repo and stay in sync with whatever Word/Excel produces) we
// hand-roll the *minimum* set of XML parts that the OOXML standard
// requires for the package to validate. OnlyOffice opens these without
// complaint, and on first save the editor rewrites the file with its
// own fuller part set anyway — so we only need to be valid on the very
// first read.
//
// The contents for each format are: a content-types manifest, a root
// relationships file, and the smallest possible main-part XML that
// counts as "an empty document/workbook/presentation". No theme, no
// styles, no app/core properties — those are all optional per ECMA-376.
package officeblank

import (
	"archive/zip"
	"bytes"
	"fmt"
)

// Kind is the variety of office document to produce. Stringly-typed to
// keep the call site obvious ("docx" reads better than a custom enum at
// the HTTP layer).
type Kind string

const (
	KindDocx Kind = "docx"
	KindXlsx Kind = "xlsx"
	KindPptx Kind = "pptx"
)

// Result is the generated blob plus the metadata callers need to stamp
// onto the file row (mime + extension).
type Result struct {
	Bytes []byte
	Mime  string
	Ext   string
}

// Generate returns a minimal valid OOXML package for the given kind.
// Returns an error only for unknown kinds — the zip writer never fails
// on an in-memory buffer with well-formed inputs.
func Generate(kind Kind) (*Result, error) {
	switch kind {
	case KindDocx:
		b, err := buildZip(docxParts())
		if err != nil {
			return nil, err
		}
		return &Result{
			Bytes: b,
			Mime:  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			Ext:   "docx",
		}, nil
	case KindXlsx:
		b, err := buildZip(xlsxParts())
		if err != nil {
			return nil, err
		}
		return &Result{
			Bytes: b,
			Mime:  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			Ext:   "xlsx",
		}, nil
	case KindPptx:
		b, err := buildZip(pptxParts())
		if err != nil {
			return nil, err
		}
		return &Result{
			Bytes: b,
			Mime:  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			Ext:   "pptx",
		}, nil
	default:
		return nil, fmt.Errorf("officeblank: unknown kind %q", kind)
	}
}

// part is one entry inside the OOXML zip. Path is the in-archive name
// (no leading slash); body is the verbatim file contents.
type part struct {
	path string
	body []byte
}

// buildZip writes parts in the given order into a zip stream and
// returns the complete buffer. We use store-only (no deflate) for the
// content-types and rels parts — they're tiny enough that compressing
// them costs more bytes in the zip headers than it saves. The main XML
// part uses Deflate so the archive stays compact when callers iterate
// over multiple blanks (e.g. a "create 100 docs" batch).
func buildZip(parts []part) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, p := range parts {
		method := zip.Deflate
		// [Content_Types].xml and *.rels are conventionally stored
		// uncompressed; some lenient readers (older Office viewers)
		// rely on the manifest being trivially extractable.
		if p.path == "[Content_Types].xml" || hasSuffix(p.path, ".rels") {
			method = zip.Store
		}
		w, err := zw.CreateHeader(&zip.FileHeader{
			Name:   p.path,
			Method: method,
		})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(p.body); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func hasSuffix(s, suf string) bool {
	if len(s) < len(suf) {
		return false
	}
	return s[len(s)-len(suf):] == suf
}

// ---------- DOCX ----------------------------------------------------

func docxParts() []part {
	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

	rootRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

	// One empty paragraph keeps Word/OnlyOffice happy — a body with zero
	// content children renders, but an empty body element trips some
	// validators that expect at least one block-level child.
	document := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p/></w:body>
</w:document>`

	return []part{
		{path: "[Content_Types].xml", body: []byte(contentTypes)},
		{path: "_rels/.rels", body: []byte(rootRels)},
		{path: "word/document.xml", body: []byte(document)},
	}
}

// ---------- XLSX ----------------------------------------------------

func xlsxParts() []part {
	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`

	rootRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

	workbook := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`

	workbookRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

	sheet := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData/>
</worksheet>`

	return []part{
		{path: "[Content_Types].xml", body: []byte(contentTypes)},
		{path: "_rels/.rels", body: []byte(rootRels)},
		{path: "xl/workbook.xml", body: []byte(workbook)},
		{path: "xl/_rels/workbook.xml.rels", body: []byte(workbookRels)},
		{path: "xl/worksheets/sheet1.xml", body: []byte(sheet)},
	}
}

// ---------- PPTX ----------------------------------------------------

// PPTX is structurally heavier than docx/xlsx: PowerPoint and OnlyOffice
// both refuse a presentation that lacks a slide layout + slide master,
// so the minimum part list is roughly double. We still skip optional
// pieces (theme, notes, table styles, view properties).
func pptxParts() []part {
	contentTypes := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
</Types>`

	rootRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`

	presentation := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`

	presentationRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`

	slide := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
</p:spTree></p:cSld>
</p:sld>`

	slideRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`

	slideLayout := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
</p:spTree></p:cSld>
</p:sldLayout>`

	slideLayoutRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`

	slideMaster := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`

	slideMasterRels := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`

	return []part{
		{path: "[Content_Types].xml", body: []byte(contentTypes)},
		{path: "_rels/.rels", body: []byte(rootRels)},
		{path: "ppt/presentation.xml", body: []byte(presentation)},
		{path: "ppt/_rels/presentation.xml.rels", body: []byte(presentationRels)},
		{path: "ppt/slides/slide1.xml", body: []byte(slide)},
		{path: "ppt/slides/_rels/slide1.xml.rels", body: []byte(slideRels)},
		{path: "ppt/slideLayouts/slideLayout1.xml", body: []byte(slideLayout)},
		{path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", body: []byte(slideLayoutRels)},
		{path: "ppt/slideMasters/slideMaster1.xml", body: []byte(slideMaster)},
		{path: "ppt/slideMasters/_rels/slideMaster1.xml.rels", body: []byte(slideMasterRels)},
	}
}
