// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package printers_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// stub implementations
// ---------------------------------------------------------------------------

type stubDispatcher struct{ called bool }

func (s *stubDispatcher) Dispatch(_ context.Context, _ json.RawMessage, _ json.RawMessage, _ string, _ *slog.Logger) printers.DispatchOutcome {
	s.called = true
	return printers.DispatchOutcome{OK: true, RemoteFilename: "stub.gcode"}
}

type stubWatcher struct{ called bool }

func (s *stubWatcher) Watch(_ context.Context, _ json.RawMessage, _ json.RawMessage, _ string, _ printers.Reporter, _ printers.WatchOpts, _ *slog.Logger) error {
	s.called = true
	return nil
}

// ---------------------------------------------------------------------------
// Register + Lookup
// ---------------------------------------------------------------------------

func TestRegisterAndLookup(t *testing.T) {
	printers.Reset()
	t.Cleanup(printers.Reset)

	d := &stubDispatcher{}
	w := &stubWatcher{}
	printers.Register(printers.Protocol{
		Kinds:         []string{"test_proto"},
		Dispatcher:    d,
		StatusWatcher: w,
	})

	p, ok := printers.Lookup("test_proto")
	if !ok {
		t.Fatal("Lookup: expected ok=true for registered kind")
	}
	if p.Dispatcher == nil {
		t.Fatal("Lookup: Dispatcher is nil")
	}
	if p.StatusWatcher == nil {
		t.Fatal("Lookup: StatusWatcher is nil")
	}
}

func TestLookup_UnknownKind(t *testing.T) {
	printers.Reset()
	t.Cleanup(printers.Reset)

	_, ok := printers.Lookup("no_such_proto")
	if ok {
		t.Fatal("Lookup: expected ok=false for unregistered kind")
	}
}

func TestRegister_MultipleKinds(t *testing.T) {
	printers.Reset()
	t.Cleanup(printers.Reset)

	d := &stubDispatcher{}
	w := &stubWatcher{}
	printers.Register(printers.Protocol{
		Kinds:         []string{"kind_a", "kind_b"},
		Dispatcher:    d,
		StatusWatcher: w,
	})

	for _, k := range []string{"kind_a", "kind_b"} {
		if _, ok := printers.Lookup(k); !ok {
			t.Errorf("Lookup(%q): expected ok=true", k)
		}
	}
}

func TestRegister_DuplicatePanics(t *testing.T) {
	printers.Reset()
	t.Cleanup(printers.Reset)

	d := &stubDispatcher{}
	w := &stubWatcher{}
	printers.Register(printers.Protocol{Kinds: []string{"dup_kind"}, Dispatcher: d, StatusWatcher: w})

	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic on duplicate Register, got none")
		}
	}()
	printers.Register(printers.Protocol{Kinds: []string{"dup_kind"}, Dispatcher: d, StatusWatcher: w})
}

func TestReset_ClearsRegistry(t *testing.T) {
	printers.Reset()
	t.Cleanup(printers.Reset)

	d := &stubDispatcher{}
	w := &stubWatcher{}
	printers.Register(printers.Protocol{Kinds: []string{"ephemeral"}, Dispatcher: d, StatusWatcher: w})

	printers.Reset()

	_, ok := printers.Lookup("ephemeral")
	if ok {
		t.Fatal("Reset: kind still present after Reset")
	}
}
