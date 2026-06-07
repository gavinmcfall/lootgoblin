package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/version"
)

func TestPrintVersion_ContainsVersion(t *testing.T) {
	var buf bytes.Buffer
	printVersion(&buf)
	got := buf.String()
	if !strings.Contains(got, version.Version) {
		t.Errorf("printVersion output %q does not contain Version %q", got, version.Version)
	}
}

func TestPrintVersion_ContainsCommitAndDate(t *testing.T) {
	var buf bytes.Buffer
	printVersion(&buf)
	got := buf.String()
	if !strings.Contains(got, "commit") {
		t.Errorf("printVersion output %q does not contain 'commit'", got)
	}
	if !strings.Contains(got, "built") {
		t.Errorf("printVersion output %q does not contain 'built'", got)
	}
}

func TestPrintVersion_LdflagsInjection(t *testing.T) {
	// Simulate what -ldflags -X injection would do at link time.
	orig := version.Version
	defer func() { version.Version = orig }()

	version.Version = "9.8.7"
	var buf bytes.Buffer
	printVersion(&buf)
	got := buf.String()
	if !strings.Contains(got, "9.8.7") {
		t.Errorf("printVersion output %q does not reflect injected Version 9.8.7", got)
	}
}
