// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package moonraker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// Adapter types — wrap the existing Dispatch / Subscribe functions to satisfy
// the printers.Dispatcher and printers.StatusWatcher interfaces.
// ---------------------------------------------------------------------------

// adapter implements both printers.Dispatcher and printers.StatusWatcher for
// the Moonraker/Klipper protocol.  A single zero-value instance is registered.
type adapter struct{}

// Dispatch parses the raw cfg/cred JSON and delegates to the package-level
// Dispatch function.  A nil http.Client is passed (same default as today).
// On a parse error the outcome mirrors how the orchestrator handled parse
// errors before the registry was introduced: OK=false, Reason="unknown",
// Details=<error message>.
func (adapter) Dispatch(
	ctx context.Context,
	cfg json.RawMessage,
	cred json.RawMessage,
	artifactPath string,
	log *slog.Logger,
) printers.DispatchOutcome {
	connCfg, err := ParseConnectionConfig(cfg)
	if err != nil {
		return printers.DispatchOutcome{
			OK:      false,
			Reason:  "unknown",
			Details: fmt.Sprintf("parse connection_config: %s", err.Error()),
		}
	}

	var credPtr *Credential
	if len(cred) > 0 && string(cred) != "null" {
		c, cerr := ParseCredential(cred)
		if cerr != nil {
			return printers.DispatchOutcome{
				OK:      false,
				Reason:  "unknown",
				Details: fmt.Sprintf("parse credential: %s", cerr.Error()),
			}
		}
		credPtr = &c
	}

	// Dispatch with nil http.Client → uses the 60-second default.
	return Dispatch(ctx, connCfg, credPtr, artifactPath, nil, log)
}

// Watch parses the raw cfg/cred JSON and delegates to the package-level
// Subscribe function.  opts.DensityGCm3 and opts.DiameterMm are forwarded to
// Subscribe as density/diameter.
func (adapter) Watch(
	ctx context.Context,
	cfg json.RawMessage,
	cred json.RawMessage,
	jobID string,
	reporter printers.Reporter,
	opts printers.WatchOpts,
	log *slog.Logger,
) error {
	connCfg, err := ParseConnectionConfig(cfg)
	if err != nil {
		return fmt.Errorf("moonraker watch: parse connection_config: %w", err)
	}

	var credPtr *Credential
	if len(cred) > 0 && string(cred) != "null" {
		c, cerr := ParseCredential(cred)
		if cerr != nil {
			return fmt.Errorf("moonraker watch: parse credential: %w", cerr)
		}
		credPtr = &c
	}

	return Subscribe(ctx, connCfg, credPtr, jobID, reporter, opts.DensityGCm3, opts.DiameterMm, log)
}

// ---------------------------------------------------------------------------
// Register — call this once to wire Moonraker into the printers registry.
// It is idempotent: if the registry already contains the kinds it is a no-op
// (safe to call from both MakeJobHandler and test setup).
// ---------------------------------------------------------------------------

// registered guards idempotency.
var registered bool

// Register adds the Moonraker adapter to the printers registry under the
// "fdm_klipper" kind.  Calling Register more than once is a no-op.
func Register() {
	if registered {
		return
	}
	registered = true
	printers.Register(printers.Protocol{
		Kinds:         []string{"fdm_klipper"},
		Dispatcher:    adapter{},
		StatusWatcher: adapter{},
	})
}
