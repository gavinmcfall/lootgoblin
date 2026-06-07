package octoprint

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
// the OctoPrint protocol. A single zero-value instance is registered.
type adapter struct{}

// Dispatch parses the raw cfg/cred JSON and delegates to the package-level
// Dispatch function. A nil http.Client is passed (uses the 60-second default).
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

	return Dispatch(ctx, connCfg, credPtr, artifactPath, nil, log)
}

// Watch parses the raw cfg/cred JSON and delegates to the package-level
// Subscribe function. WatchOpts are accepted for interface compliance but
// OctoPrint does not use density/diameter (no measured consumption).
func (adapter) Watch(
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
		return fmt.Errorf("octoprint watch: parse connection_config: %w", err)
	}

	var credPtr *Credential
	if len(cred) > 0 && string(cred) != "null" {
		c, cerr := ParseCredential(cred)
		if cerr != nil {
			return fmt.Errorf("octoprint watch: parse credential: %w", cerr)
		}
		credPtr = &c
	}

	return Subscribe(ctx, connCfg, credPtr, jobID, reporter, log)
}

// ---------------------------------------------------------------------------
// Register — call this once to wire OctoPrint into the printers registry.
// It is idempotent: calling Register more than once is a no-op.
// ---------------------------------------------------------------------------

// registered guards idempotency.
var registered bool

// Register adds the OctoPrint adapter to the printers registry under the
// "fdm_octoprint" kind. Calling Register more than once is a no-op.
func Register() {
	if registered {
		return
	}
	registered = true
	printers.Register(printers.Protocol{
		Kinds:         []string{Kind},
		Dispatcher:    adapter{},
		StatusWatcher: adapter{},
	})
}
