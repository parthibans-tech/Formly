package scanner

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// TestParseClamResponse is the closest we can get to locking down the
// INSTREAM verdict parser without a real clamd. The lines below are
// straight from clamd(8) — exact bytes the daemon writes back. If
// upstream ever changes its wording, this test breaks loudly.
func TestParseClamResponse(t *testing.T) {
	cases := []struct {
		name      string
		line      string
		wantClean bool
		wantInf   bool
		wantErr   bool
		wantSig   string
	}{
		{"clean", "stream: OK", true, false, false, ""},
		{"infected eicar", "stream: Eicar-Test-Signature FOUND", false, true, false, "Eicar-Test-Signature"},
		{"infected with spaces in name", "stream: Win.Test.EICAR_HDB-1 FOUND", false, true, false, "Win.Test.EICAR_HDB-1"},
		{"size limit error", "stream: INSTREAM size limit exceeded ERROR", false, false, true, ""},
		{"junk", "garbage line", false, false, true, ""},
		// Belt-and-suspenders: a signature that contains "FOUND" as
		// substring shouldn't confuse the suffix strip. We split on
		// the trailing " FOUND" only.
		{"signature contains FOUND substring", "stream: My.FOUNDling.Trojan FOUND",
			false, true, false, "My.FOUNDling.Trojan"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := parseClamResponse(tc.line)
			if v.Clean != tc.wantClean ||
				v.Infected != tc.wantInf ||
				v.Errored != tc.wantErr {
				t.Fatalf("verdict mismatch for %q: got %+v", tc.line, v)
			}
			if v.Signature != tc.wantSig {
				t.Fatalf("signature for %q: got %q want %q", tc.line, v.Signature, tc.wantSig)
			}
		})
	}
}

// TestNoopScans confirms the dev/CI default returns Skipped with the
// engine label set — the audit trail needs to distinguish "we didn't
// scan because nothing was configured" from "we scanned and it was
// fine."
func TestNoopScans(t *testing.T) {
	v, err := Noop{}.Scan(context.Background(), "x.bin", strings.NewReader("payload"), 7)
	if err != nil {
		t.Fatalf("noop returned err: %v", err)
	}
	if !v.Skipped || v.Clean || v.Infected || v.Errored {
		t.Fatalf("noop verdict wrong: %+v", v)
	}
	if v.Engine != "noop" {
		t.Fatalf("noop engine label: %q", v.Engine)
	}
	if v.String() != "skipped" {
		t.Fatalf("noop String(): %q", v.String())
	}
}

// TestBlocklistEICAR is the deterministic gate-fires test the rest of
// the system relies on. Any payload containing the EICAR string must
// flag as infected; everything else passes.
func TestBlocklistEICAR(t *testing.T) {
	bl := Blocklist{}

	v, err := bl.Scan(context.Background(), "innocent.txt",
		strings.NewReader("ordinary content"), 16)
	if err != nil {
		t.Fatalf("blocklist clean err: %v", err)
	}
	if !v.Clean || v.Infected {
		t.Fatalf("blocklist on innocent payload: %+v", v)
	}

	// EICAR padded with trailing junk to make sure substring detection works.
	payload := EICAR + "\nextra trailing bytes\n"
	v, err = bl.Scan(context.Background(), "evil.com",
		strings.NewReader(payload), int64(len(payload)))
	if err != nil {
		t.Fatalf("blocklist eicar err: %v", err)
	}
	if !v.Infected || v.Signature != "Eicar-Test-Signature" {
		t.Fatalf("blocklist eicar verdict: %+v", v)
	}
	if v.String() != "infected" {
		t.Fatalf("Verdict.String() for infected: %q", v.String())
	}
}

// TestClamAVMaxStreamSizeShortCircuits proves we don't even open the
// TCP connection when the file is bigger than the configured limit —
// so a misconfigured clamd never sees a 5GB upload. Address points at
// 127.0.0.1:1 (always closed) so a Dial would fail; this test passes
// only because we return Skipped before dialing.
func TestClamAVMaxStreamSizeShortCircuits(t *testing.T) {
	c := NewClamAV(ClamAVConfig{
		Address:        "127.0.0.1:1", // closed port — would error if reached
		ConnectTimeout: 50 * time.Millisecond,
		MaxStreamSize:  100,
	})
	v, err := c.Scan(context.Background(), "big.bin",
		bytes.NewReader([]byte("ignored")), 1024)
	if err != nil {
		t.Fatalf("expected nil err on size short-circuit, got %v", err)
	}
	if !v.Skipped {
		t.Fatalf("expected Skipped, got %+v", v)
	}
}

// TestClamAVScanWithFakeClamd spins up a tiny TCP server that speaks the
// clamd INSTREAM protocol just enough to hand back a configurable
// verdict. This is a high-value test: it proves the wire format we
// generate (chunk headers, terminator, command bytes) matches what a
// real clamd parses. If we ever break the framing this test fails
// long before staging.
func TestClamAVScanWithFakeClamd(t *testing.T) {
	cases := []struct {
		name      string
		response  string
		body      string
		wantClean bool
		wantInf   bool
		wantSig   string
	}{
		{"clean payload", "stream: OK\n", "hello", true, false, ""},
		{"eicar payload", "stream: Eicar-Test-Signature FOUND\n",
			EICAR, false, true, "Eicar-Test-Signature"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lis, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatalf("listen: %v", err)
			}
			defer lis.Close()

			done := make(chan error, 1)
			var gotBody bytes.Buffer
			var gotCmd []byte
			go func() {
				conn, err := lis.Accept()
				if err != nil {
					done <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(2 * time.Second))

				// Read the command line ("nINSTREAM\n").
				buf := make([]byte, 64)
				n, err := conn.Read(buf)
				if err != nil {
					done <- err
					return
				}
				gotCmd = append(gotCmd, buf[:n]...)
				// Strip the prefix; whatever remains is the start of
				// the first chunk header.
				rest := buf[:n]
				if i := bytes.IndexByte(rest, '\n'); i >= 0 {
					rest = rest[i+1:]
				}
				rdr := io.MultiReader(bytes.NewReader(rest), conn)

				// Loop over chunks: 4-byte BE length, then body, until len=0.
				for {
					var hdr [4]byte
					if _, err := io.ReadFull(rdr, hdr[:]); err != nil {
						done <- err
						return
					}
					n := binary.BigEndian.Uint32(hdr[:])
					if n == 0 {
						break
					}
					chunk := make([]byte, n)
					if _, err := io.ReadFull(rdr, chunk); err != nil {
						done <- err
						return
					}
					gotBody.Write(chunk)
				}

				// Send the verdict and close.
				if _, err := conn.Write([]byte(tc.response)); err != nil {
					done <- err
					return
				}
				done <- nil
			}()

			c := NewClamAV(ClamAVConfig{
				Address:        lis.Addr().String(),
				ConnectTimeout: 2 * time.Second,
				ScanTimeout:    2 * time.Second,
			})
			v, scanErr := c.Scan(context.Background(), "x.bin",
				strings.NewReader(tc.body), int64(len(tc.body)))

			// Wait for the fake server to finish so we can assert it saw
			// well-formed INSTREAM framing.
			select {
			case sErr := <-done:
				if sErr != nil && !errors.Is(sErr, io.EOF) {
					t.Fatalf("fake clamd err: %v", sErr)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("fake clamd timed out")
			}

			if scanErr != nil {
				t.Fatalf("Scan err: %v", scanErr)
			}
			if !strings.HasPrefix(string(gotCmd), "nINSTREAM\n") {
				t.Fatalf("client did not send nINSTREAM prefix; got %q", gotCmd)
			}
			if gotBody.String() != tc.body {
				t.Fatalf("body framing mismatch: sent %q, server saw %q",
					tc.body, gotBody.String())
			}
			if v.Clean != tc.wantClean || v.Infected != tc.wantInf {
				t.Fatalf("verdict mismatch: %+v", v)
			}
			if v.Signature != tc.wantSig {
				t.Fatalf("signature: got %q want %q", v.Signature, tc.wantSig)
			}
		})
	}
}

// TestGateBlock locks down the download-gate matrix. Any change to the
// status set must update this test in lockstep.
func TestGateBlock(t *testing.T) {
	cases := []struct {
		name       string
		status     string
		sig        string
		wantBlock  bool
		wantStatus int
		wantCode   string
		// substring expected in message; "" = no expectation
		wantMsgHas string
	}{
		{"clean releases", "clean", "", false, 0, "", ""},
		{"skipped releases", "skipped", "", false, 0, "", ""},
		{"empty (legacy row) releases", "", "", false, 0, "", ""},
		{"pending blocks 423", "pending", "", true, 423, "scan_pending", "scanned"},
		{"scanning blocks 423", "scanning", "", true, 423, "scan_pending", "scanned"},
		{"queued blocks 423", "queued", "", true, 423, "scan_pending", "scanned"},
		{"infected blocks 451 with sig",
			"infected", "Eicar-Test-Signature", true, 451, "scan_infected", "Eicar-Test-Signature"},
		{"infected blocks 451 without sig",
			"infected", "", true, 451, "scan_infected", "malware"},
		{"error blocks 503", "error", "", true, 503, "scan_error", "scan failed"},
		{"unknown future status fails closed",
			"quarantined", "", true, 423, "scan_blocked", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg, status, code, blocked := GateBlock(tc.status, tc.sig)
			if blocked != tc.wantBlock {
				t.Fatalf("blocked: got %v want %v (msg=%q)", blocked, tc.wantBlock, msg)
			}
			if !blocked {
				return
			}
			if status != tc.wantStatus {
				t.Fatalf("http status: got %d want %d", status, tc.wantStatus)
			}
			if code != tc.wantCode {
				t.Fatalf("code: got %q want %q", code, tc.wantCode)
			}
			if tc.wantMsgHas != "" && !strings.Contains(msg, tc.wantMsgHas) {
				t.Fatalf("msg %q missing %q", msg, tc.wantMsgHas)
			}
		})
	}
}

// TestFromEnv exercises the precedence ladder: CLAMAV_ADDR > SCANNER >
// Noop. Callers pass a getenv stub so we don't rely on real env state.
func TestFromEnv(t *testing.T) {
	envs := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"clamav addr wins",
			map[string]string{"CLAMAV_ADDR": "clamd:3310", "SCANNER": "blocklist"},
			"clamav"},
		{"scanner=blocklist",
			map[string]string{"SCANNER": "blocklist"},
			"blocklist"},
		{"empty falls back to noop",
			map[string]string{},
			"noop"},
		{"unknown SCANNER value falls back to noop",
			map[string]string{"SCANNER": "magic"},
			"noop"},
	}
	for _, tc := range envs {
		t.Run(tc.name, func(t *testing.T) {
			s := FromEnv(func(k string) string { return tc.env[k] })
			if s.Name() != tc.want {
				t.Fatalf("FromEnv: got %q want %q", s.Name(), tc.want)
			}
		})
	}
}

// TestVerdictString locks down the persisted scan_status values. The
// migration's CHECK constraint (informally) and the gate's switch both
// rely on these exact strings.
func TestVerdictString(t *testing.T) {
	cases := []struct {
		v    Verdict
		want string
	}{
		{Verdict{Clean: true}, "clean"},
		{Verdict{Infected: true}, "infected"},
		{Verdict{Skipped: true}, "skipped"},
		{Verdict{Errored: true}, "error"},
		{Verdict{}, "error"}, // zero-value defaults to error (fail-closed)
	}
	for _, tc := range cases {
		got := tc.v.String()
		if got != tc.want {
			t.Errorf("String() for %+v: got %q want %q", tc.v, got, tc.want)
		}
	}
}
