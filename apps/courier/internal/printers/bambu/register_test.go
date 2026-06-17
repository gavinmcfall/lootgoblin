// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package bambu_test

// register_test.go — black-box test that Register() wires all 13 Bambu kinds.
//
// Uses the external test package (bambu_test) to avoid sharing the
// package-level `registered` bool with production code, and uses
// printers.Reset() to ensure a clean slate independent of other test runs.

import (
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers/bambu"
)

func TestRegister_AllKindsResolve(t *testing.T) {
	printers.Reset()
	defer printers.Reset()

	bambu.Register()

	for _, kind := range bambu.Kinds {
		proto, ok := printers.Lookup(kind)
		if !ok {
			t.Errorf("Lookup(%q) = not found after Register()", kind)
			continue
		}
		if proto.Dispatcher == nil {
			t.Errorf("Lookup(%q).Dispatcher is nil", kind)
		}
		if proto.StatusWatcher == nil {
			t.Errorf("Lookup(%q).StatusWatcher is nil", kind)
		}
	}
	if t.Failed() {
		t.FailNow()
	}
}

// TestRegister_Idempotent verifies that Register() can be called more than
// once without panic.  Because the `registered` guard is package-level and
// persists for the lifetime of the test binary, this test works regardless
// of whether a prior test already invoked Register().
func TestRegister_Idempotent(t *testing.T) {
	// Calling Register() twice (or more) in a single binary run must not panic.
	// If already registered (from another test), the second call is a no-op.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Register() panicked on second call: %v", r)
		}
	}()
	bambu.Register()
	bambu.Register()
}

func TestRegister_Kinds_Count(t *testing.T) {
	if len(bambu.Kinds) != 13 {
		t.Errorf("expected 13 Bambu kinds, got %d: %v", len(bambu.Kinds), bambu.Kinds)
	}
}
