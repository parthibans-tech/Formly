package ocr

import (
	"context"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeLayoutSidecar mints an httptest.Server that mimics the
// /layout/pdf and /layout/image endpoints' wire shape closely enough
// that the Go client's parsing can be exercised end to end. The
// validate hook lets each test assert on the multipart body the
// client sent (e.g. lang field, max_pages field).
func fakeLayoutSidecar(t *testing.T, path, body string, validate func(*testing.T, map[string]string, []byte)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		ct := r.Header.Get("Content-Type")
		_, params, err := mime.ParseMediaType(ct)
		if err != nil {
			http.Error(w, "bad content-type: "+err.Error(), http.StatusBadRequest)
			return
		}
		mr := multipart.NewReader(r.Body, params["boundary"])
		fields := map[string]string{}
		var fileBytes []byte
		for {
			p, err := mr.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			b, _ := io.ReadAll(p)
			if p.FormName() == "file" {
				fileBytes = b
			} else {
				fields[p.FormName()] = string(b)
			}
		}
		if validate != nil {
			validate(t, fields, fileBytes)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
}

func TestLayoutPDF_RoundTrip(t *testing.T) {
	body := `{"pages":[
		{"w":850,"h":1100,"boxes":[
			{"text":"Name","bbox":[10,20,40,15],"conf":0.99},
			{"text":"_______","bbox":[60,20,300,15],"conf":0.42}
		]},
		{"w":850,"h":1100,"boxes":[
			{"text":"Signature","bbox":[10,900,80,18],"conf":0.97}
		]}
	]}`
	srv := fakeLayoutSidecar(t, "/layout/pdf", body, func(t *testing.T, f map[string]string, file []byte) {
		if f["lang"] != "en" {
			t.Errorf("lang field = %q, want en", f["lang"])
		}
		if f["max_pages"] != "5" {
			t.Errorf("max_pages = %q, want 5", f["max_pages"])
		}
		if f["dpi"] != "200" {
			t.Errorf("dpi = %q, want 200", f["dpi"])
		}
		if string(file) != "fakepdfbytes" {
			t.Errorf("file body = %q, want fakepdfbytes", file)
		}
	})
	defer srv.Close()

	cfg := Config{
		Enabled:        true,
		BaseURL:        srv.URL,
		Lang:           "en",
		MaxPages:       5,
		DPI:            200,
		PerPageTimeout: 5 * time.Second,
	}
	pages, err := cfg.LayoutPDF(context.Background(), []byte("fakepdfbytes"))
	if err != nil {
		t.Fatalf("LayoutPDF: %v", err)
	}
	if len(pages) != 2 {
		t.Fatalf("got %d pages, want 2", len(pages))
	}
	p0 := pages[0]
	if p0.W != 850 || p0.H != 1100 {
		t.Errorf("page 0 dims = %dx%d, want 850x1100", p0.W, p0.H)
	}
	if len(p0.Boxes) != 2 {
		t.Fatalf("page 0 boxes = %d, want 2", len(p0.Boxes))
	}
	b0 := p0.Boxes[0]
	if b0.Text != "Name" {
		t.Errorf("box 0 text = %q, want Name", b0.Text)
	}
	if b0.X != 10 || b0.Y != 20 || b0.W != 40 || b0.H != 15 {
		t.Errorf("box 0 expanded coords = %.0f,%.0f %.0fx%.0f, want 10,20 40x15",
			b0.X, b0.Y, b0.W, b0.H)
	}
	if b0.Bbox != [4]float64{10, 20, 40, 15} {
		t.Errorf("box 0 raw bbox = %v, want [10 20 40 15]", b0.Bbox)
	}
	if b0.Confidence != 0.99 {
		t.Errorf("box 0 conf = %v, want 0.99", b0.Confidence)
	}
	if pages[1].Boxes[0].Text != "Signature" {
		t.Errorf("page 1 box 0 text = %q, want Signature", pages[1].Boxes[0].Text)
	}
}

func TestLayoutPDF_DisabledShortCircuits(t *testing.T) {
	cfg := Config{Enabled: false}
	pages, err := cfg.LayoutPDF(context.Background(), []byte("anything"))
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("err = %v, want ErrDisabled", err)
	}
	if pages != nil {
		t.Errorf("pages = %v, want nil", pages)
	}
}

func TestLayoutPDF_EmptyBody(t *testing.T) {
	cfg := Config{Enabled: true, BaseURL: "http://unused", Lang: "en", PerPageTimeout: time.Second}
	pages, err := cfg.LayoutPDF(context.Background(), nil)
	if err != nil {
		t.Errorf("err = %v, want nil", err)
	}
	if pages != nil {
		t.Errorf("pages = %v, want nil for empty body", pages)
	}
}

func TestLayoutPDF_SidecarErrorWrapped(t *testing.T) {
	cfg := Config{
		Enabled:        true,
		BaseURL:        "http://127.0.0.1:1", // refused
		Lang:           "en",
		MaxPages:       1,
		PerPageTimeout: time.Second,
	}
	_, err := cfg.LayoutPDF(context.Background(), []byte("body"))
	if err == nil {
		t.Fatal("want error, got nil")
	}
	if !errors.Is(err, ErrSidecarUnavailable) {
		t.Errorf("err = %v, want wrapped ErrSidecarUnavailable", err)
	}
}

func TestLayoutImage_RoundTrip(t *testing.T) {
	body := `{"w":640,"h":480,"boxes":[
		{"text":"Hello","bbox":[5,10,80,18],"conf":0.95}
	]}`
	srv := fakeLayoutSidecar(t, "/layout/image", body, func(t *testing.T, f map[string]string, file []byte) {
		if f["lang"] != "hi" {
			t.Errorf("lang = %q, want hi (profile override)", f["lang"])
		}
		if string(file) != "imgbytes" {
			t.Errorf("file = %q, want imgbytes", file)
		}
	})
	defer srv.Close()

	cfg := Config{
		Enabled:        true,
		BaseURL:        srv.URL,
		Lang:           "hi",
		PerPageTimeout: 5 * time.Second,
	}
	page, err := cfg.LayoutImage(context.Background(), []byte("imgbytes"))
	if err != nil {
		t.Fatalf("LayoutImage: %v", err)
	}
	if page == nil {
		t.Fatal("page = nil")
	}
	if page.W != 640 || page.H != 480 {
		t.Errorf("dims = %dx%d, want 640x480", page.W, page.H)
	}
	if len(page.Boxes) != 1 {
		t.Fatalf("boxes = %d, want 1", len(page.Boxes))
	}
	b := page.Boxes[0]
	if b.Text != "Hello" {
		t.Errorf("text = %q, want Hello", b.Text)
	}
	if b.X != 5 || b.Y != 10 || b.W != 80 || b.H != 18 {
		t.Errorf("bbox expanded = %.0f,%.0f %.0fx%.0f, want 5,10 80x18", b.X, b.Y, b.W, b.H)
	}
}

func TestLayoutImage_DisabledShortCircuits(t *testing.T) {
	cfg := Config{Enabled: false}
	page, err := cfg.LayoutImage(context.Background(), []byte("img"))
	if !errors.Is(err, ErrDisabled) {
		t.Fatalf("err = %v, want ErrDisabled", err)
	}
	if page != nil {
		t.Errorf("page = %+v, want nil", page)
	}
}

func TestLayoutImage_EmptyBody(t *testing.T) {
	cfg := Config{Enabled: true, BaseURL: "http://unused", Lang: "en", PerPageTimeout: time.Second}
	page, err := cfg.LayoutImage(context.Background(), nil)
	if err != nil {
		t.Errorf("err = %v, want nil", err)
	}
	if page != nil {
		t.Errorf("page = %+v, want nil for empty body", page)
	}
}

func TestLayoutPDF_BadJSONIsReported(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"pages": "not-an-array"}`)
	}))
	defer srv.Close()

	cfg := Config{
		Enabled:        true,
		BaseURL:        srv.URL,
		Lang:           "en",
		MaxPages:       1,
		PerPageTimeout: time.Second,
	}
	_, err := cfg.LayoutPDF(context.Background(), []byte("body"))
	if err == nil {
		t.Fatal("want decode error, got nil")
	}
	if !strings.Contains(err.Error(), "decode layout response") {
		t.Errorf("err = %v, want decode-response wrap", err)
	}
}
