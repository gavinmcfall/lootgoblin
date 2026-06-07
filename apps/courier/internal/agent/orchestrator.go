// Package agent — orchestrator.go
//
// MakeJobHandler returns the JobHandler closure that routes a claimed job to
// the appropriate printer protocol adapter via the printers registry.
//
// # Protocol registry
//
// Protocols register themselves under one or more printer.Kind strings via
// printers.Register.  MakeJobHandler calls moonraker.Register() to ensure the
// Moonraker/Klipper adapter is wired before the handler runs.  Future
// protocols register themselves the same way.
//
// # "we sent the file ≠ the print failed" contract
//
// After a successful Dispatch the handler calls the protocol's StatusWatcher
// to watch the print to terminal.  If Watch returns an error (websocket drop,
// network blip, courier restart) the handler logs the error and returns it —
// which tells RunClaimLoop to log it — but does NOT post a failed status
// report.  The job remains in "dispatched" state server-side.  Server-side
// reconciliation or a future courier reconnect is responsible for deciding the
// final outcome.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers/moonraker"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers/octoprint"
)

// moonrakerKind is the printer.Kind value the server stores for
// Moonraker/Klipper printers.  Confirmed from the server-side adapter:
//
//	apps/server/src/forge/dispatch/moonraker/adapter.ts → MOONRAKER_KIND = 'fdm_klipper'
const moonrakerKind = "fdm_klipper"

// MakeJobHandler constructs the JobHandler closure used by RunClaimLoop.
// client is used to report status back to the central instance; density and
// diameter are the filament defaults for the Moonraker filament-consumption
// calculation.
//
// The returned handler:
//  1. Routes by bundle.Printer.Kind via the printers registry.
//  2. Unknown kinds → failed{unsupported-protocol}.
//  3. Passes raw ConnectionConfig and Credential JSON to the protocol adapter.
//  4. On dispatch failure: posts failed{reason, details} and returns nil.
//  5. On success: posts dispatched{remote_filename} and then calls Watch.
//     Watch errors are returned (not a failed report).
func MakeJobHandler(
	client *central.Client,
	density, diameter float64,
	log *slog.Logger,
) JobHandler {
	// Wire adapters into the registry (idempotent).
	moonraker.Register()
	octoprint.Register()

	return func(ctx context.Context, bundle *central.ClaimBundle, artifactPath string) error {
		jobID := bundle.Job.ID

		// ------------------------------------------------------------------
		// 1. Guard: nil Printer.
		// ------------------------------------------------------------------
		if bundle.Printer == nil {
			// Should not happen for a dispatch job, but guard defensively.
			if err := client.ReportStatus(ctx, central.FailedReport(
				jobID,
				"unsupported-protocol",
				"courier: claim bundle missing printer record",
			)); err != nil {
				log.Warn("orchestrator: failed to report status", "job_id", jobID, "error", err)
			}
			return fmt.Errorf("orchestrator: job %s has no printer record", jobID)
		}

		// ------------------------------------------------------------------
		// 2. Route by printer kind via registry.
		// ------------------------------------------------------------------
		proto, ok := printers.Lookup(bundle.Printer.Kind)
		if !ok {
			log.Warn("orchestrator: unsupported printer kind",
				"job_id", jobID,
				"kind", bundle.Printer.Kind,
			)
			if err := client.ReportStatus(ctx, central.FailedReport(
				jobID,
				"unsupported-protocol",
				fmt.Sprintf("courier: no adapter registered for printer kind %q", bundle.Printer.Kind),
			)); err != nil {
				log.Warn("orchestrator: failed to report status", "job_id", jobID, "error", err)
			}
			return nil // not a handler error; the failure was reported
		}

		// ------------------------------------------------------------------
		// 3. Resolve credential raw JSON (nil credential → null JSON).
		// ------------------------------------------------------------------
		var credRaw json.RawMessage
		if bundle.Credential != nil {
			credRaw = bundle.Credential.Payload
		}

		// ------------------------------------------------------------------
		// 4. Dispatch the artifact.
		// ------------------------------------------------------------------
		outcome := proto.Dispatcher.Dispatch(
			ctx,
			bundle.Printer.ConnectionConfig,
			credRaw,
			artifactPath,
			log,
		)

		if !outcome.OK {
			log.Warn("orchestrator: dispatch failed",
				"job_id", jobID,
				"reason", outcome.Reason,
				"details", outcome.Details,
			)
			if rerr := client.ReportStatus(ctx, central.FailedReport(
				jobID,
				outcome.Reason,
				outcome.Details,
			)); rerr != nil {
				log.Warn("orchestrator: failed to report status", "job_id", jobID, "error", rerr)
			}
			return nil // dispatch failure is reported; no Watch to attempt
		}

		// ------------------------------------------------------------------
		// 5. Report dispatched.
		// ------------------------------------------------------------------
		if rerr := client.ReportStatus(ctx, central.DispatchedReport(jobID, outcome.RemoteFilename)); rerr != nil {
			// Non-fatal: log and continue to Watch anyway.
			log.Warn("orchestrator: failed to report dispatched",
				"job_id", jobID,
				"remote_filename", outcome.RemoteFilename,
				"error", rerr,
			)
		}

		// ------------------------------------------------------------------
		// 6. Subscribe to the print status feed.
		//
		// A Watch error (connection drop, etc.) is returned so RunClaimLoop
		// can log it.  We do NOT post a failed report — the file was already
		// sent to the printer.  "we sent the file ≠ the print failed."
		// ------------------------------------------------------------------
		log.Info("orchestrator: subscribing to print status",
			"job_id", jobID,
			"remote_filename", outcome.RemoteFilename,
		)
		if serr := proto.StatusWatcher.Watch(
			ctx,
			bundle.Printer.ConnectionConfig,
			credRaw,
			jobID,
			client,
			printers.WatchOpts{DensityGCm3: density, DiameterMm: diameter},
			log,
		); serr != nil {
			log.Warn("orchestrator: status feed dropped — job remains dispatched server-side",
				"job_id", jobID,
				"error", serr,
			)
			return serr // caller (RunClaimLoop) logs; job stays in 'dispatched'
		}

		return nil
	}
}
