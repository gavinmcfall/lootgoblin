// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package bambu

// ftps.go — FTPS (implicit TLS) upload to Bambu LAN printer /cache/ partition.
//
// The Bambu LAN FTP server uses a self-signed certificate that rotates per
// device, so we set InsecureSkipVerify: true.  The trust boundary is the LAN
// — TLS here provides link confidentiality, not server-identity assurance.
//
// Ports the FTPS section of adapter.ts:
//   - Connect with implicit TLS on port 990.
//   - Login user "bblp", password = credential.accessCode.
//   - Upload to /cache/<filename>.
//
// The FtpDialer interface isolates the real jlaffaye/ftp.Dial call so that
// dispatch_test.go can stub the network layer entirely.

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/jlaffaye/ftp"
)

// FtpConn is the minimal interface that the upload path requires from a
// jlaffaye/ftp *ServerConn.  Injected for testability.
type FtpConn interface {
	Login(user, password string) error
	Stor(path string, r io.Reader) error
	Quit() error
}

// FtpDialer creates an FtpConn from a host:port address and TLS config.
// The default implementation calls jlaffaye/ftp.Dial with implicit-TLS.
type FtpDialer func(addr string, tlsCfg *tls.Config) (FtpConn, error)

// DefaultFtpDialer dials the given addr (host:port) with implicit-TLS FTPS
// (Bambu LAN convention: port 990).  InsecureSkipVerify is set by the
// caller-supplied tlsCfg.
func DefaultFtpDialer(addr string, tlsCfg *tls.Config) (FtpConn, error) {
	conn, err := ftp.Dial(addr, ftp.DialWithTLS(tlsCfg))
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// ftpAuthRE matches FTP 530-level auth rejection messages.
// Mirrors FTP_AUTH_RE in adapter.ts.
var ftpAuthRE = regexp.MustCompile(`(?i)\b530\b|login failed|login incorrect|incorrect password|authentication failed|not logged in`)

// networkCodeRE matches network-unreachable errno strings.
var networkCodeRE = regexp.MustCompile(`(?i)ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH`)

// timeoutRE matches timeout message strings.
var timeoutRE = regexp.MustCompile(`(?i)timeout|timed out`)

// ftpUploadResult carries a normalised failure reason + optional detail.
type ftpUploadResult struct {
	OK     bool
	Reason string // one of: unreachable|auth-failed|timeout|unknown
	Detail string
}

// UploadArtifact connects to the Bambu FTPS server, logs in with bblp +
// accessCode, uploads the file at artifactPath to /cache/<filename>, and
// quits.
//
// dialer may be nil; DefaultFtpDialer is used in that case.
// ctx is checked for cancellation before connecting.
func UploadArtifact(
	ctx context.Context,
	cfg ConnectionConfig,
	cred Credential,
	artifactPath string,
	dialer FtpDialer,
) ftpUploadResult {
	if dialer == nil {
		dialer = DefaultFtpDialer
	}

	// Honour context cancellation before touching the network.
	if err := ctx.Err(); err != nil {
		return ftpUploadResult{Reason: "timeout", Detail: err.Error()}
	}

	filename := filepath.Base(artifactPath)
	addr := fmt.Sprintf("%s:%d", cfg.IP, cfg.FtpPort)

	tlsCfg := &tls.Config{
		//nolint:gosec // self-signed LAN cert; trust boundary is the LAN
		InsecureSkipVerify: true,
	}

	conn, err := dialer(addr, tlsCfg)
	if err != nil {
		return ftpUploadResult{Reason: classifyFtpErr(err.Error()), Detail: err.Error()}
	}
	defer func() { _ = conn.Quit() }()

	if err := conn.Login(BambuLanUsername, cred.AccessCode); err != nil {
		reason := "auth-failed"
		msg := err.Error()
		if !ftpAuthRE.MatchString(msg) {
			reason = classifyFtpErr(msg)
		}
		return ftpUploadResult{Reason: reason, Detail: msg}
	}

	f, err := os.Open(artifactPath)
	if err != nil {
		return ftpUploadResult{Reason: "unknown", Detail: fmt.Sprintf("failed to open artifact: %s", err.Error())}
	}
	defer f.Close()

	remotePath := "/cache/" + filename
	if err := conn.Stor(remotePath, f); err != nil {
		return ftpUploadResult{Reason: classifyFtpErr(err.Error()), Detail: err.Error()}
	}

	return ftpUploadResult{OK: true}
}

// classifyFtpErr maps a raw error message to one of the dispatch failure
// reason strings, matching the Node adapter's FTP error mapping.
func classifyFtpErr(msg string) string {
	upper := strings.ToUpper(msg)
	if timeoutRE.MatchString(msg) || strings.Contains(upper, "ETIMEDOUT") {
		return "timeout"
	}
	if networkCodeRE.MatchString(msg) || networkCodeRE.MatchString(upper) {
		return "unreachable"
	}
	if ftpAuthRE.MatchString(msg) {
		return "auth-failed"
	}
	return "unknown"
}
