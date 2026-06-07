// Package version holds the canonical version string for the courier binary.
// Version, Commit, and Date are injectable at build time via -ldflags -X.
package version

// Version matches the server major version.
// Declared as a var (not const) so -ldflags -X can override it at link time.
var Version = "2.0.0"

// Commit is the VCS commit hash injected at build time.
var Commit = "unknown"

// Date is the build timestamp injected at build time.
var Date = "unknown"

// String returns a human-readable version string suitable for version output.
func String() string {
	return Version + " (commit " + Commit + ", built " + Date + ")"
}
