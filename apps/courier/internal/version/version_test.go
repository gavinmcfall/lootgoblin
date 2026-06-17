// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package version_test

import (
	"strings"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/version"
)

func TestVersionDefaults(t *testing.T) {
	if version.Version == "" {
		t.Fatal("Version must not be empty")
	}
	if version.Commit == "" {
		t.Fatal("Commit must not be empty")
	}
	if version.Date == "" {
		t.Fatal("Date must not be empty")
	}
}

func TestString_ContainsVersion(t *testing.T) {
	s := version.String()
	if !strings.Contains(s, version.Version) {
		t.Errorf("String() = %q, want it to contain Version %q", s, version.Version)
	}
}

func TestString_ContainsCommitAndDate(t *testing.T) {
	s := version.String()
	if !strings.Contains(s, "commit") {
		t.Errorf("String() = %q, expected to contain 'commit'", s)
	}
	if !strings.Contains(s, "built") {
		t.Errorf("String() = %q, expected to contain 'built'", s)
	}
}

func TestString_Format(t *testing.T) {
	// Save originals and restore after test.
	origVersion := version.Version
	origCommit := version.Commit
	origDate := version.Date
	defer func() {
		version.Version = origVersion
		version.Commit = origCommit
		version.Date = origDate
	}()

	version.Version = "1.2.3"
	version.Commit = "abc1234"
	version.Date = "2026-06-07"

	want := "1.2.3 (commit abc1234, built 2026-06-07)"
	got := version.String()
	if got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}
