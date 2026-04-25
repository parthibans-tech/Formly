// Package scanner is the antivirus / malware scan abstraction. The
// production implementation talks to a ClamAV daemon (clamd) over TCP
// using the INSTREAM protocol; the dev/CI default is a no-op that
// passes everything as clean. A "blocklist" stub is included for tests
// that want to assert the gate fires (it returns INFECTED for any input
// containing the EICAR test string).
//
// Why an interface, not a direct clamav dep on the call sites: the
// download presign / files.Complete handlers should not know whether
// the verdict came from clamd, a future cloud-AV service, or no-op.
// They want one method: "is this file safe to release?" That stays
// stable as the engine changes underneath.
package scanner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// Verdict is the post-scan summary the caller persists onto the file
// row. Exactly one of Clean / Infected / Skipped / Errored is true.
type Verdict struct {
	Clean     bool
	Infected  bool
	Skipped   bool   // engine declined to scan (e.g. file too large)
	Errored   bool   // engine had a transport / parse failure
	Signature string // virus name when Infected (e.g. "Eicar-Test-Signature")
	Engine    string // human label: "clamav", "noop", "blocklist"
	Message   string // optional engine-supplied detail (logged, not shown)
}

// Scanner is the production-facing interface. Implementations MUST be
// safe for concurrent calls — the worker runs N goroutines in parallel.
type Scanner interface {
	// Name is the engine label that gets stamped onto files.scan_engine
	// and surfaced in audit logs. Stable, human-readable, lowercase.
	Name() string

	// Scan reads the entire content of `body` and returns a verdict.
	// `size` is informational (lets engines skip oversize content
	// rather than streaming GBs into a doomed scan). Implementations
	// must respect ctx cancellation so the worker can shut down
	// promptly on SIGTERM.
	Scan(ctx context.Context, name string, body io.Reader, size int64) (Verdict, error)
}

// ---------------------------------------------------------------------
// Noop
// ---------------------------------------------------------------------

// Noop is the dev/CI default. Returns Skipped (not Clean) so we don't
// pretend a real scan happened — the gate treats Skipped as releasable
// (because the org admin opted out of strict scanning), but operators
// can still distinguish "Scanner ran and was happy" from "no scanner
// configured" in the audit trail.
type Noop struct{}

func (Noop) Name() string { return "noop" }

func (Noop) Scan(_ context.Context, _ string, body io.Reader, _ int64) (Verdict, error) {
	// Drain the reader so callers can `defer body.Close()` without
	// leaking — same contract as the real scanner.
	_, _ = io.Copy(io.Discard, body)
	return Verdict{Skipped: true, Engine: "noop", Message: "no scanner configured"}, nil
}

// ---------------------------------------------------------------------
// EICAR blocklist (testing helper)
// ---------------------------------------------------------------------

// EICAR is the canonical antivirus test string. Every real engine
// flags this; we have it as a constant so the Blocklist scanner and
// integration tests stay in lockstep.
const EICAR = `X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`

// Blocklist is a deterministic stand-in for ClamAV used in tests and
// when ClamAV is unavailable but you still want a working gate (e.g. a
// staging environment). It flags any payload that contains the EICAR
// string. Anything else is clean.
type Blocklist struct{}

func (Blocklist) Name() string { return "blocklist" }

func (Blocklist) Scan(_ context.Context, _ string, body io.Reader, _ int64) (Verdict, error) {
	buf, err := io.ReadAll(body)
	if err != nil {
		return Verdict{Errored: true, Engine: "blocklist", Message: err.Error()}, err
	}
	if bytes.Contains(buf, []byte(EICAR)) {
		return Verdict{
			Infected:  true,
			Signature: "Eicar-Test-Signature",
			Engine:    "blocklist",
		}, nil
	}
	return Verdict{Clean: true, Engine: "blocklist"}, nil
}

// ---------------------------------------------------------------------
// ClamAV (clamd INSTREAM)
// ---------------------------------------------------------------------

// ClamAVConfig configures the production scanner. Address is `host:port`
// (default clamd listens on 3310). MaxStreamSize bounds how much we'll
// stream in a single INSTREAM call — clamd has its own StreamMaxLength
// (default 25 MB); the two should agree. Connect / Scan timeouts are
// enforced separately so a hung clamd doesn't pin a worker forever.
type ClamAVConfig struct {
	Address        string
	ConnectTimeout time.Duration
	ScanTimeout    time.Duration
	// MaxStreamSize is the largest single file we'll send to clamd. If
	// set and `size` exceeds it, Scan returns Skipped immediately. 0
	// means "no client-side limit; let clamd decide".
	MaxStreamSize int64
}

// DefaultClamAVConfig returns sensible production defaults. Callers can
// override individual fields after the call — this is just a starting
// point so config structs don't bloat with init boilerplate.
func DefaultClamAVConfig(address string) ClamAVConfig {
	return ClamAVConfig{
		Address:        address,
		ConnectTimeout: 5 * time.Second,
		ScanTimeout:    60 * time.Second,
		// Match clamd default StreamMaxLength so we fail fast rather
		// than streaming a gigabyte into a connection clamd will
		// truncate anyway.
		MaxStreamSize: 26214400, // 25 MiB
	}
}

// ClamAV wraps a clamd-compatible scanner. Each Scan opens a fresh TCP
// connection — clamd's INSTREAM is one-shot per connection (it closes
// after returning the verdict), and the fast-path connect cost is
// negligible compared to scan time.
type ClamAV struct {
	cfg ClamAVConfig
}

func NewClamAV(cfg ClamAVConfig) *ClamAV {
	if cfg.ConnectTimeout == 0 {
		cfg.ConnectTimeout = 5 * time.Second
	}
	if cfg.ScanTimeout == 0 {
		cfg.ScanTimeout = 60 * time.Second
	}
	return &ClamAV{cfg: cfg}
}

func (c *ClamAV) Name() string { return "clamav" }

// Scan streams body to clamd via INSTREAM and parses the response.
//
// INSTREAM protocol (from clamd(8)):
//
//   - Send `nINSTREAM\n`. The leading `n` (instead of `z`) makes clamd
//     respond with newline-terminated text, simpler to parse.
//   - Send N chunks. Each chunk is prefixed with a 4-byte big-endian
//     length followed by the chunk body. Final terminator is a single
//     4-byte 0.
//   - Read response until newline. Format is `stream: <verdict>\n`
//     where verdict is `OK`, `<NAME> FOUND`, or `<msg> ERROR`.
//
// Any IO error is returned with Errored=true so the worker can mark the
// scan_jobs row 'error' and the file 'error' (which the gate refuses to
// release — fail-closed is the correct posture for a security check).
func (c *ClamAV) Scan(ctx context.Context, _ string, body io.Reader, size int64) (Verdict, error) {
	if c.cfg.MaxStreamSize > 0 && size > c.cfg.MaxStreamSize {
		return Verdict{
			Skipped: true,
			Engine:  "clamav",
			Message: fmt.Sprintf("size %d exceeds scanner limit %d", size, c.cfg.MaxStreamSize),
		}, nil
	}

	d := net.Dialer{Timeout: c.cfg.ConnectTimeout}
	conn, err := d.DialContext(ctx, "tcp", c.cfg.Address)
	if err != nil {
		return Verdict{Errored: true, Engine: "clamav", Message: err.Error()}, err
	}
	defer conn.Close()

	// One deadline covers the whole exchange. clamd doesn't support
	// per-message deadlines, and a stuck scan should bail out at the
	// transport level rather than hanging forever.
	if c.cfg.ScanTimeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(c.cfg.ScanTimeout))
	}

	if _, err := conn.Write([]byte("nINSTREAM\n")); err != nil {
		return Verdict{Errored: true, Engine: "clamav", Message: err.Error()}, err
	}

	// 64 KB chunks — clamd's default StreamMaxLength is 25 MiB; we
	// want enough chunks to keep the pipeline busy without burning CPU
	// on length-prefix overhead.
	const chunkSize = 64 * 1024
	chunk := make([]byte, chunkSize)
	for {
		n, rerr := io.ReadFull(body, chunk)
		if n > 0 {
			var hdr [4]byte
			binary.BigEndian.PutUint32(hdr[:], uint32(n))
			if _, werr := conn.Write(hdr[:]); werr != nil {
				return Verdict{Errored: true, Engine: "clamav", Message: werr.Error()}, werr
			}
			if _, werr := conn.Write(chunk[:n]); werr != nil {
				return Verdict{Errored: true, Engine: "clamav", Message: werr.Error()}, werr
			}
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			return Verdict{Errored: true, Engine: "clamav", Message: rerr.Error()}, rerr
		}
	}
	// Zero-length terminator tells clamd we're done.
	if _, err := conn.Write([]byte{0, 0, 0, 0}); err != nil {
		return Verdict{Errored: true, Engine: "clamav", Message: err.Error()}, err
	}

	// Read one line of verdict. `bufio.NewReader` lets us re-use the
	// connection's buffered bytes if clamd writes in fragments.
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return Verdict{Errored: true, Engine: "clamav", Message: err.Error()}, err
	}
	return parseClamResponse(strings.TrimSpace(line)), nil
}

// parseClamResponse turns "stream: OK" / "stream: Eicar-Test-Signature
// FOUND" / "stream: <msg> ERROR" into a Verdict. Exported via tests so
// we don't have to spin up a real clamd to lock the parser down.
func parseClamResponse(line string) Verdict {
	// Strip the "stream:" prefix clamd uses for INSTREAM responses.
	const prefix = "stream:"
	body := strings.TrimSpace(strings.TrimPrefix(line, prefix))

	switch {
	case body == "OK":
		return Verdict{Clean: true, Engine: "clamav"}
	case strings.HasSuffix(body, " FOUND"):
		// "<name> FOUND" — strip the trailing " FOUND" to extract the
		// signature. Use TrimSuffix instead of slicing so we tolerate
		// signatures that happen to contain "FOUND" as a substring.
		name := strings.TrimSpace(strings.TrimSuffix(body, " FOUND"))
		return Verdict{
			Infected:  true,
			Signature: name,
			Engine:    "clamav",
		}
	case strings.HasSuffix(body, " ERROR"):
		msg := strings.TrimSpace(strings.TrimSuffix(body, " ERROR"))
		return Verdict{
			Errored: true,
			Engine:  "clamav",
			Message: msg,
		}
	}
	return Verdict{
		Errored: true,
		Engine:  "clamav",
		Message: "unrecognized clamd response: " + line,
	}
}

// ---------------------------------------------------------------------
// Selection from env
// ---------------------------------------------------------------------

// FromEnv picks a Scanner based on environment variables. Order of
// precedence:
//
//  1. CLAMAV_ADDR=host:port → ClamAV TCP scanner.
//  2. SCANNER=blocklist → deterministic EICAR blocklist (test/staging).
//  3. otherwise → Noop.
//
// Returning a concrete type rather than `Scanner` would lock callers in;
// the interface return type lets cmd/api and cmd/worker treat the
// scanner as opaque.
func FromEnv(getenv func(string) string) Scanner {
	if addr := getenv("CLAMAV_ADDR"); addr != "" {
		cfg := DefaultClamAVConfig(addr)
		return NewClamAV(cfg)
	}
	if getenv("SCANNER") == "blocklist" {
		return Blocklist{}
	}
	return Noop{}
}

// Verdict helpers ------------------------------------------------------

// GateBlock translates a persisted scan_status into the response a
// download/share-resolve handler should write when the gate refuses
// release. Returns (message, httpStatus, errCode, blocked). When
// blocked=false the caller proceeds normally.
//
// Why centralize: every handler that hands out a presigned URL —
// files.Download, sharing resolve, image preview, template preview —
// has to apply the same policy. A duplicated `switch` in N places is
// the kind of place a future engineer adds a new state and forgets to
// update the others. Single source of truth.
//
// The signature parameter (only set for 'infected' rows) is included
// in the message so admins can correlate with their AV vendor's
// signature DB without an extra DB read.
func GateBlock(scanStatus, signature string) (msg string, httpStatus int, code string, blocked bool) {
	switch scanStatus {
	case "clean", "skipped", "":
		// "" tolerates legacy rows from before the migration; treated
		// as releasable. Backfill ran the migration with default
		// 'skipped' so this is belt-and-suspenders.
		return "", 0, "", false
	case "pending", "queued", "scanning":
		return "file is being scanned for malware; try again in a moment",
			423, "scan_pending", true
	case "infected":
		m := "file failed malware scan and cannot be downloaded"
		if signature != "" {
			m += " (" + signature + ")"
		}
		return m, 451, "scan_infected", true
	case "error":
		return "file scan failed; downloads are blocked until rescanned",
			503, "scan_error", true
	}
	// Unknown / future status: fail closed.
	return "file is not available for download", 423, "scan_blocked", true
}

// String returns the canonical scan_status value for a verdict —
// 'clean' | 'infected' | 'error' | 'skipped'. Persisted in the
// files.scan_status column and read by the download gate.
func (v Verdict) String() string {
	switch {
	case v.Clean:
		return "clean"
	case v.Infected:
		return "infected"
	case v.Skipped:
		return "skipped"
	}
	return "error"
}
