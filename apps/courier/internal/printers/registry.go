// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package printers defines the protocol registry for the courier.  Each
// printer protocol (Moonraker, OctoPrint, SDCP, …) registers itself under one
// or more printer.Kind strings.  The orchestrator looks up the protocol by
// kind and delegates dispatch and status-watching through the Dispatcher /
// StatusWatcher interfaces.
package printers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

// DispatchOutcome is the result of a Dispatcher.Dispatch call.
type DispatchOutcome struct {
	OK             bool
	RemoteFilename string // populated on success
	Reason         string // populated on failure: unreachable|auth-failed|rejected|no-credentials|timeout|unknown
	Details        string // optional human-readable detail
}

// Reporter is the minimal interface a StatusWatcher needs to call back to the
// central instance.  *central.Client satisfies this interface.
type Reporter interface {
	ReportStatus(ctx context.Context, payload central.StatusReport) error
}

// WatchOpts carries per-watch parameters.  Moonraker uses DensityGCm3 and
// DiameterMm for filament-consumption calculation; other protocols may ignore
// them.
type WatchOpts struct {
	DensityGCm3 float64
	DiameterMm  float64
}

// ---------------------------------------------------------------------------
// Protocol interfaces
// ---------------------------------------------------------------------------

// Dispatcher is implemented by each protocol adapter to upload an artifact to
// the target printer.  cfg and cred are protocol-specific raw JSON; the adapter
// parses them internally.
type Dispatcher interface {
	Dispatch(
		ctx context.Context,
		cfg json.RawMessage,
		cred json.RawMessage,
		artifactPath string,
		log *slog.Logger,
	) DispatchOutcome
}

// StatusWatcher is implemented by each protocol adapter to subscribe to the
// printer's status feed after a successful dispatch.
type StatusWatcher interface {
	Watch(
		ctx context.Context,
		cfg json.RawMessage,
		cred json.RawMessage,
		jobID string,
		reporter Reporter,
		opts WatchOpts,
		log *slog.Logger,
	) error
}

// Protocol groups a Dispatcher and StatusWatcher under one or more printer
// Kind strings.
type Protocol struct {
	Kinds         []string
	Dispatcher    Dispatcher
	StatusWatcher StatusWatcher
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

var (
	mu       sync.RWMutex
	registry = map[string]Protocol{}
)

// Register adds p to the registry under each of its Kinds.  It panics if any
// Kind is already registered (duplicate-registration guard).
func Register(p Protocol) {
	mu.Lock()
	defer mu.Unlock()
	for _, k := range p.Kinds {
		if _, exists := registry[k]; exists {
			panic(fmt.Sprintf("printers: kind %q is already registered", k))
		}
		registry[k] = p
	}
}

// Lookup returns the Protocol registered for kind and true, or the zero
// Protocol and false when no protocol handles kind.
func Lookup(kind string) (Protocol, bool) {
	mu.RLock()
	defer mu.RUnlock()
	p, ok := registry[kind]
	return p, ok
}

// Reset clears the registry.  It is intended for use in tests only.
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	registry = map[string]Protocol{}
}
