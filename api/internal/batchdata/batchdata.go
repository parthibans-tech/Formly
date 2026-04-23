// Package batchdata normalizes different tabular input formats (CSV, XLSX,
// Google Sheets public URLs) into a shared (headers, rows) shape so the batch
// generation worker stays source-agnostic.
package batchdata

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// Detect infers the input kind from a filename. Defaults to csv.
func Detect(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".xlsx", ".xlsm":
		return "xlsx"
	case ".tsv":
		return "tsv"
	default:
		return "csv"
	}
}

// Parse returns (headers, rows) from the given bytes according to `kind`.
// The first row is treated as headers; at least one data row is required.
func Parse(kind string, data []byte) (headers []string, rows [][]string, err error) {
	switch strings.ToLower(kind) {
	case "xlsx", "xlsm":
		return parseXLSX(data)
	case "tsv":
		return parseCSVSep(data, '\t')
	default:
		return parseCSVSep(data, ',')
	}
}

func parseCSVSep(data []byte, sep rune) ([]string, [][]string, error) {
	reader := csv.NewReader(bytes.NewReader(data))
	reader.Comma = sep
	reader.FieldsPerRecord = -1 // tolerate short rows
	all, err := reader.ReadAll()
	if err != nil {
		return nil, nil, fmt.Errorf("parse csv: %w", err)
	}
	if len(all) < 2 {
		return nil, nil, fmt.Errorf("need a header row and at least one data row")
	}
	return all[0], all[1:], nil
}

func parseXLSX(data []byte) ([]string, [][]string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, nil, fmt.Errorf("open xlsx: %w", err)
	}
	defer f.Close()
	sheets := f.GetSheetList()
	if len(sheets) == 0 {
		return nil, nil, fmt.Errorf("xlsx has no sheets")
	}
	rows, err := f.GetRows(sheets[0])
	if err != nil {
		return nil, nil, fmt.Errorf("read xlsx: %w", err)
	}
	if len(rows) < 2 {
		return nil, nil, fmt.Errorf("xlsx needs a header row and at least one data row")
	}
	return rows[0], rows[1:], nil
}

// -- Google Sheets --------------------------------------------------------

var sheetRE = regexp.MustCompile(`/spreadsheets/d/([a-zA-Z0-9_-]+)`)
var gidRE = regexp.MustCompile(`[?#&]gid=(\d+)`)

// GoogleSheetCSVURL converts an edit URL or sharing URL into the public CSV
// export URL. Returns an error if the URL doesn't look like a Google Sheet.
func GoogleSheetCSVURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	if !strings.Contains(u.Host, "google.com") {
		return "", fmt.Errorf("not a google sheets url")
	}
	m := sheetRE.FindStringSubmatch(u.Path)
	if len(m) < 2 {
		return "", fmt.Errorf("couldn't extract sheet id from url")
	}
	id := m[1]
	gid := "0"
	if g := gidRE.FindStringSubmatch(raw); len(g) >= 2 {
		gid = g[1]
	}
	return fmt.Sprintf("https://docs.google.com/spreadsheets/d/%s/export?format=csv&gid=%s", id, gid), nil
}

// FetchPublic downloads the given URL (typically a sheet CSV export) with a
// short timeout and a size cap. Returns the bytes.
func FetchPublic(ctx interface{ Done() <-chan struct{} }, raw string) ([]byte, error) {
	client := &http.Client{Timeout: 20 * time.Second}
	req, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("fetch %d: %s", resp.StatusCode, resp.Status)
	}
	// Cap at 10 MB — batches should be modest.
	return io.ReadAll(io.LimitReader(resp.Body, 10<<20))
}
