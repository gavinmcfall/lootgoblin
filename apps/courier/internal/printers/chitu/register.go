// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package chitu

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// kindAdapter — per-kind adapter; pins the printer kind for Dispatch so the
// capability matrix lookup works correctly. Each ChituNetwork kind gets its
// own kindAdapter registered under its specific kind string.
// ---------------------------------------------------------------------------

type kindAdapter struct {
	kind string
}

func (a kindAdapter) Dispatch(
	ctx context.Context,
	cfg json.RawMessage,
	_ json.RawMessage,
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
	return Dispatch(ctx, connCfg, a.kind, artifactPath, nil, log)
}

func (a kindAdapter) Watch(
	ctx context.Context,
	cfg json.RawMessage,
	_ json.RawMessage,
	jobID string,
	reporter printers.Reporter,
	_ printers.WatchOpts,
	log *slog.Logger,
) error {
	connCfg, err := ParseConnectionConfig(cfg)
	if err != nil {
		return fmt.Errorf("chitu watch: parse connection_config: %w", err)
	}
	return Subscribe(ctx, connCfg, jobID, reporter, log, nil, nil)
}

// ---------------------------------------------------------------------------
// Register — idempotent; wire the ChituNetwork adapter under all 7 per-model kinds.
// ---------------------------------------------------------------------------

var registered bool

// Register adds the ChituNetwork adapter to the printers registry under all 7
// per-model kinds listed in Kinds. Calling Register more than once is a no-op.
func Register() {
	if registered {
		return
	}
	registered = true
	for _, kind := range Kinds {
		k := kind // capture
		printers.Register(printers.Protocol{
			Kinds:         []string{k},
			Dispatcher:    kindAdapter{kind: k},
			StatusWatcher: kindAdapter{kind: k},
		})
	}
}
