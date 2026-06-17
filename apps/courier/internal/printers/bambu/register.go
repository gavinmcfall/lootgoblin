// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package bambu

// register.go — wires the Bambu LAN adapter into the printers registry.
//
// Part 2 of the Bambu LAN protocol port (V2-006c C-C).
//
// adapter implements printers.Dispatcher (wraps Dispatch with real default
// DispatchDeps) and printers.StatusWatcher (wraps Subscribe with the real
// default MqttStatusClientFactory).
//
// Register() is idempotent: safe to call from both MakeJobHandler and test
// setup.  It registers all 13 Bambu LAN kinds under the same adapter.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// adapter — implements printers.Dispatcher + printers.StatusWatcher
// ---------------------------------------------------------------------------

type bambuAdapter struct{}

// Dispatch parses the raw cfg/cred JSON and delegates to the package-level
// Dispatch function with production defaults (real FTP dialer + real MQTT
// factory).
func (bambuAdapter) Dispatch(
	ctx context.Context,
	cfg json.RawMessage,
	cred json.RawMessage,
	artifactPath string,
	log *slog.Logger,
) printers.DispatchOutcome {
	return Dispatch(ctx, cfg, cred, artifactPath, log, DispatchDeps{})
}

// Watch parses the raw cfg/cred JSON and delegates to the package-level
// Subscribe function with the default MQTT factory.
//
// WatchOpts fields (DensityGCm3, DiameterMm) are Moonraker-specific and are
// ignored by the Bambu adapter — Bambu surfaces per-slot remain% instead.
func (bambuAdapter) Watch(
	ctx context.Context,
	cfg json.RawMessage,
	cred json.RawMessage,
	jobID string,
	reporter printers.Reporter,
	_ printers.WatchOpts,
	log *slog.Logger,
) error {
	connCfg, err := ParseConnectionConfig(cfg)
	if err != nil {
		return fmt.Errorf("bambu watch: parse connection_config: %w", err)
	}
	credPayload, err := ParseCredential(cred)
	if err != nil {
		return fmt.Errorf("bambu watch: parse credential: %w", err)
	}
	// Subscribe with nil factory → DefaultMqttStatusClientFactory.
	return Subscribe(ctx, connCfg, credPayload, jobID, reporter, nil, log)
}

// ---------------------------------------------------------------------------
// Register — idempotent registry wire
// ---------------------------------------------------------------------------

// registered guards against double-registration.
var registered bool

// Register adds the Bambu LAN adapter to the printers registry under all 13
// Kinds.  Calling Register more than once is a no-op.
func Register() {
	if registered {
		return
	}
	registered = true
	printers.Register(printers.Protocol{
		Kinds:         Kinds,
		Dispatcher:    bambuAdapter{},
		StatusWatcher: bambuAdapter{},
	})
}
