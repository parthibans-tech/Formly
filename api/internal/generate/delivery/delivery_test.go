package delivery

// Unit tests for the pure helpers (placeholder resolution,
// recipient expansion, EmailConfig knob handling). The end-to-end
// fan-out path is exercised by the runner integration tests.

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestResolvePlaceholders(t *testing.T) {
	data := map[string]interface{}{
		"customerName":  "Acme",
		"invoiceNumber": 42,
	}
	cases := []struct {
		in, want string
	}{
		{"plain text", "plain text"},
		{"Hi {{customerName}}", "Hi Acme"},
		{"#{{invoiceNumber}}", "#42"},
		{"missing {{nope}} here", "missing  here"},
		{"{{customerName}} & {{customerName}}", "Acme & Acme"},
	}
	for _, c := range cases {
		got := resolvePlaceholders(c.in, data)
		if got != c.want {
			t.Errorf("resolvePlaceholders(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestResolveRecipients(t *testing.T) {
	data := map[string]interface{}{
		"manager":  "alice@example.com",
		"customer": "bob@example.com",
	}
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{
			name: "literals",
			in:   []string{"a@x.com", "b@x.com"},
			want: []string{"a@x.com", "b@x.com"},
		},
		{
			name: "placeholder",
			in:   []string{"{{manager}}", "{{customer}}"},
			want: []string{"alice@example.com", "bob@example.com"},
		},
		{
			name: "comma-separated single entry",
			in:   []string{"{{manager}},{{customer}}"},
			want: []string{"alice@example.com", "bob@example.com"},
		},
		{
			name: "unresolved placeholder dropped",
			in:   []string{"{{nope}}", "{{manager}}"},
			want: []string{"alice@example.com"},
		},
		{
			name: "dedupe",
			in:   []string{"{{manager}}", "alice@example.com"},
			want: []string{"alice@example.com"},
		},
		{
			name: "blank entries skipped",
			in:   []string{"", "  ", "{{manager}}"},
			want: []string{"alice@example.com"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := resolveRecipients(c.in, data)
			sort.Strings(got)
			sort.Strings(c.want)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("resolveRecipients = %v, want %v", got, c.want)
			}
		})
	}
}

func TestConfigIsEnabled(t *testing.T) {
	if (Config{}).IsEnabled() {
		t.Error("empty config should be disabled")
	}
	if (Config{Email: &EmailConfig{}}).IsEnabled() {
		t.Error("email block without Enabled=true should be disabled")
	}
	if !(Config{Email: &EmailConfig{Enabled: true}}).IsEnabled() {
		t.Error("email enabled should report enabled")
	}
	if !(Config{Share: &ShareConfig{Enabled: true}}).IsEnabled() {
		t.Error("share enabled should report enabled")
	}
}

func TestBuildEmailOptionsAttachmentDefault(t *testing.T) {
	cfg := &EmailConfig{
		Enabled: true,
		To:      []string{"a@x.com"},
		Subject: "{{customerName}} invoice",
		Body:    "Hi {{customerName}}",
	}
	args := Args{
		OutputName:  "out.pdf",
		OutputBytes: []byte("PDF"),
		Data:        map[string]interface{}{"customerName": "Acme"},
	}
	got := buildEmailOptions(cfg, args, Result{})
	if got.Subject != "Acme invoice" {
		t.Errorf("subject = %q, want %q", got.Subject, "Acme invoice")
	}
	if got.TextBody != "Hi Acme" {
		t.Errorf("body = %q, want %q", got.TextBody, "Hi Acme")
	}
	if len(got.Attachments) != 1 {
		t.Fatalf("attachments len = %d, want 1 (default-on)", len(got.Attachments))
	}
}

func TestBuildEmailOptionsAttachmentDisabled(t *testing.T) {
	off := false
	cfg := &EmailConfig{
		Enabled:   true,
		To:        []string{"a@x.com"},
		AttachPDF: &off,
	}
	got := buildEmailOptions(cfg, Args{OutputBytes: []byte("PDF")}, Result{})
	if len(got.Attachments) != 0 {
		t.Errorf("attachments len = %d, want 0 when AttachPDF=false", len(got.Attachments))
	}
}

func TestBuildEmailOptionsLinksAppended(t *testing.T) {
	cfg := &EmailConfig{
		Enabled:             true,
		To:                  []string{"a@x.com"},
		Body:                "Hello",
		IncludeDownloadLink: true,
		IncludeShareLink:    true,
	}
	res := Result{
		DownloadURL: "https://files.example/dl",
		ShareURL:    "https://app.example/share/abc",
	}
	got := buildEmailOptions(cfg, Args{}, res)
	want := "Hello\n\nShare link: https://app.example/share/abc\nDownload link: https://files.example/dl"
	if got.TextBody != want {
		t.Errorf("body =\n%q\nwant\n%q", got.TextBody, want)
	}
}

// fakePresign / fakeShare / fakeMail let us drive Apply end-to-end
// without touching any I/O.

type fakePresign struct{ url string; err error }

func (f *fakePresign) PresignGet(_ context.Context, _, _, _ string, _ time.Duration) (string, error) {
	return f.url, f.err
}

type fakeShare struct {
	called bool
	got    ShareCreateOptions
	out    ShareCreateResult
	err    error
}

func (f *fakeShare) CreateShareLink(_ context.Context, opts ShareCreateOptions) (ShareCreateResult, error) {
	f.called = true
	f.got = opts
	return f.out, f.err
}

type fakeMail struct {
	called bool
	got    EmailSendOptions
	id     string
	err    error
}

func (f *fakeMail) Send(_ context.Context, opts EmailSendOptions) (string, error) {
	f.called = true
	f.got = opts
	return f.id, f.err
}

func TestApplyHappyPath(t *testing.T) {
	pres := &fakePresign{url: "https://files/dl?sig=x"}
	sh := &fakeShare{out: ShareCreateResult{ShareID: "s1", Token: "tok", URL: "https://app/share/tok"}}
	ml := &fakeMail{id: "send-1"}
	cfg := Config{
		Email: &EmailConfig{Enabled: true, To: []string{"{{customerEmail}}"}, Subject: "Done"},
		Share: &ShareConfig{Enabled: true, Role: "viewer"},
	}
	args := Args{
		OrgID: "o1", UserID: "u1", TemplateID: "t1", TemplateName: "Invoice",
		OutputFileID: "f1", OutputKey: "orgs/o1/outputs/f1/out.pdf", OutputName: "out.pdf",
		OutputBytes: []byte("PDF"),
		Data:        map[string]interface{}{"customerEmail": "alice@x.com"},
	}
	res, err := Apply(context.Background(), cfg, Deps{Presign: pres, Share: sh, Mail: ml}, args)
	if err != nil {
		t.Fatalf("Apply err = %v", err)
	}
	if res.DownloadURL != "https://files/dl?sig=x" {
		t.Errorf("DownloadURL = %q", res.DownloadURL)
	}
	if !sh.called {
		t.Error("expected share.Create called")
	}
	if res.ShareURL != "https://app/share/tok" {
		t.Errorf("ShareURL = %q", res.ShareURL)
	}
	if !ml.called {
		t.Error("expected mail.Send called")
	}
	if res.EmailSendID != "send-1" {
		t.Errorf("EmailSendID = %q", res.EmailSendID)
	}
	if res.EmailError != nil {
		t.Errorf("EmailError = %v", res.EmailError)
	}
	// Recipient placeholder resolved.
	if len(ml.got.To) != 1 || ml.got.To[0] != "alice@x.com" {
		t.Errorf("To = %v, want [alice@x.com]", ml.got.To)
	}
}

func TestApplyEmailWithEmptyRecipients(t *testing.T) {
	cfg := Config{Email: &EmailConfig{Enabled: true, To: []string{"{{nope}}"}}}
	args := Args{
		OrgID: "o1", OutputFileID: "f1", OutputKey: "k",
		Data: map[string]interface{}{},
	}
	ml := &fakeMail{}
	res, err := Apply(context.Background(), cfg, Deps{Mail: ml}, args)
	if err != nil {
		t.Fatalf("Apply err = %v", err)
	}
	if ml.called {
		t.Error("mail.Send should NOT be called when recipients resolve empty")
	}
	if res.EmailError == nil {
		t.Error("expected EmailError when recipients resolved empty")
	}
}

func TestApplyMissingFileIDErrors(t *testing.T) {
	_, err := Apply(context.Background(), Config{}, Deps{}, Args{OrgID: "o"})
	if err == nil {
		t.Fatal("expected error when OutputFileID/OutputKey missing")
	}
}

func TestApplyShareErrorDoesNotBlockEmail(t *testing.T) {
	cfg := Config{
		Share: &ShareConfig{Enabled: true},
		Email: &EmailConfig{Enabled: true, To: []string{"a@x.com"}},
	}
	sh := &fakeShare{err: errors.New("db down")}
	ml := &fakeMail{id: "id"}
	args := Args{OrgID: "o", OutputFileID: "f1", OutputKey: "k"}
	res, err := Apply(context.Background(), cfg, Deps{Share: sh, Mail: ml}, args)
	if err != nil {
		t.Fatalf("Apply err = %v", err)
	}
	if res.ShareError == nil {
		t.Error("expected ShareError to surface")
	}
	if !ml.called {
		t.Error("email send should still happen even when share creation fails")
	}
}
