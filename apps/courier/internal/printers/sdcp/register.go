// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package sdcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// Adapter — implements printers.Dispatcher and printers.StatusWatcher.
// ---------------------------------------------------------------------------

type adapter struct{}

// Dispatch parses the raw cfg/cred JSON and delegates to the package-level
// Dispatch function. SDCP has no authentication; cred is accepted but ignored.
func (adapter) Dispatch(
	ctx context.Context,
	cfg json.RawMessage,
	_ json.RawMessage, // cred — SDCP has no auth
	artifactPath string,
	log *slog.Logger,
) printers.DispatchOutcome {
	connCfg, err := ParseConnectionConfig(cfg)
	if err != nil {
		return printers.DispatchOutcome{
			Reason:  "unknown",
			Details: fmt.Sprintf("parse connection_config: %s", err.Error()),
		}
	}
	return Dispatch(ctx, connCfg, artifactPath, nil, log)
}

// Watch parses the raw cfg JSON and delegates to the package-level Subscribe
// function. WatchOpts are accepted for interface compliance but SDCP does not
// use density/diameter (no measured consumption for resin).
func (adapter) Watch(
	ctx context.Context,
	cfg json.RawMessage,
	_ json.RawMessage, // cred — SDCP has no auth
	jobID string,
	reporter printers.Reporter,
	_ printers.WatchOpts,
	log *slog.Logger,
) error {
	connCfg, err := ParseConnectionConfig(cfg)
	if err != nil {
		return fmt.Errorf("sdcp watch: parse connection_config: %w", err)
	}
	return Subscribe(ctx, connCfg, jobID, reporter, log)
}

// ---------------------------------------------------------------------------
// Register — idempotent; wire the SDCP adapter under all 8 per-model kinds.
// ---------------------------------------------------------------------------

var registered bool

// Register adds the SDCP adapter to the printers registry under all 8 per-model
// kinds listed in Kinds. Calling Register more than once is a no-op.
func Register() {
	if registered {
		return
	}
	registered = true
	printers.Register(printers.Protocol{
		Kinds:         Kinds,
		Dispatcher:    adapter{},
		StatusWatcher: adapter{},
	})
}
