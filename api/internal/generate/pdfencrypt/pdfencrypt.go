// Package pdfencrypt applies password protection and a PDF permission
// mask to rendered PDF bytes. It's a thin adapter over pdfcpu's
// api.Encrypt — we own the policy mapping (which bool fields turn into
// which PDF permission bits) so the rest of the codebase doesn't have
// to know about pdfcpu's bit-level layout.
//
// Why both passwords matter:
//
//   - userPassword (a.k.a. "open password"): the reader prompts for this
//     before showing any content. Without it the PDF can't be opened.
//
//   - ownerPassword (a.k.a. "permissions password"): the reader needs
//     this to bypass the permission mask (print/copy/modify/annotate).
//     Without it the PDF opens but with the restricted permissions.
//
// pdfcpu requires at least an owner password to encrypt at all. If only a
// userPassword is supplied, we mirror it as the owner password — that
// matches user expectation ("I set ONE password, expect ONE prompt") and
// gives the reader a key it can validate against. Conversely, supplying
// only an ownerPassword means the document opens without prompting but
// permissions are enforced — a common workflow for "anyone can read,
// nobody can copy text without the secret".
package pdfencrypt

import (
	"bytes"
	"errors"
	"fmt"

	pdfcpuapi "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// Options describes the security policy for one render. Empty Options{}
// means "no encryption" — Apply returns the input bytes unchanged.
type Options struct {
	OwnerPassword string
	UserPassword  string

	// KeyLength is the AES key length in bits. 128 or 256. Defaults to
	// 256 (the pdfcpu default). 40-bit RC4 is intentionally not
	// exposed — modern integrators should not have an option to ship
	// trivially-cracked encryption.
	KeyLength int

	// PermissionsAll, when true, ignores the granular flags below and
	// allows everything except encryption. Useful for "lock with a
	// password but don't constrain what the user can do with it".
	PermissionsAll bool

	// Granular permissions. False = denied. Only consulted when
	// PermissionsAll is false. The default zero value is "deny everything
	// except print" (matches pdfcpu's PermissionsPrint default), which is
	// the safest sensible behaviour for a freshly-locked invoice/report.
	AllowPrint    bool
	AllowCopy     bool
	AllowModify   bool
	AllowAnnotate bool
}

// IsEnabled reports whether the options would result in encryption being
// applied. Cheap pre-check so callers can skip the buffer copy round-trip
// when nothing's set.
func (o Options) IsEnabled() bool {
	return o.OwnerPassword != "" || o.UserPassword != ""
}

// Apply returns an encrypted copy of pdfBytes per opts. When opts has no
// passwords set, the bytes are returned unchanged (security disabled).
func Apply(pdfBytes []byte, opts Options) ([]byte, error) {
	if !opts.IsEnabled() {
		return pdfBytes, nil
	}
	if len(pdfBytes) == 0 {
		return nil, errors.New("pdfencrypt: empty input")
	}

	conf := model.NewDefaultConfiguration()
	conf.ValidationMode = model.ValidationRelaxed

	owner := opts.OwnerPassword
	user := opts.UserPassword
	// pdfcpu enforces an owner password for encryption. Mirror the user
	// password when the caller only supplied one, so "single password"
	// templates do the right thing without surprising the integrator
	// with a "missing owner password" error.
	if owner == "" {
		owner = user
	}
	conf.OwnerPW = owner
	conf.UserPW = user

	// AES is the only modern PDF encryption worth offering. 256-bit by
	// default; 128 is allowed for compatibility with very old readers
	// that choke on AES-256.
	conf.EncryptUsingAES = true
	switch opts.KeyLength {
	case 128:
		conf.EncryptKeyLength = 128
	case 0, 256:
		conf.EncryptKeyLength = 256
	default:
		return nil, fmt.Errorf("pdfencrypt: unsupported key length %d (use 128 or 256)", opts.KeyLength)
	}

	conf.Permissions = buildPermissions(opts)

	rs := bytes.NewReader(pdfBytes)
	var out bytes.Buffer
	if err := pdfcpuapi.Encrypt(rs, &out, conf); err != nil {
		return nil, fmt.Errorf("pdfencrypt: encrypt: %w", err)
	}
	return out.Bytes(), nil
}

// buildPermissions translates the granular allow-flags into the bitmask
// pdfcpu expects. The base pattern is `PermissionsNone` (everything
// denied) plus whichever bits we want to grant.
//
// Note on the pdfcpu permission constants:
//
//   - PermissionPrintRev2 + PermissionPrintRev3 : print
//   - PermissionExtract + PermissionExtractRev3 : copy text/graphics
//   - PermissionModify + PermissionAssembleRev3 : modify (also assemble)
//   - PermissionModAnnFillForm + PermissionFillRev3 : annotate / fill forms
//
// We grant the rev3 (modern) AND legacy bit together — readers handling
// the older revision still need the legacy bit set to honour the grant.
func buildPermissions(opts Options) model.PermissionFlags {
	if opts.PermissionsAll {
		return model.PermissionsAll
	}
	p := model.PermissionsNone
	if opts.AllowPrint {
		p |= model.PermissionPrintRev2
		p |= model.PermissionPrintRev3
	}
	if opts.AllowCopy {
		p |= model.PermissionExtract
		p |= model.PermissionExtractRev3
	}
	if opts.AllowModify {
		p |= model.PermissionModify
		p |= model.PermissionAssembleRev3
	}
	if opts.AllowAnnotate {
		p |= model.PermissionModAnnFillForm
		p |= model.PermissionFillRev3
	}
	return p
}
