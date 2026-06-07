// Package agent — orchestrator.go
//
// MakeJobHandler returns the JobHandler closure that routes a claimed job to
// the appropriate printer protocol adapter.
//
// # Supported protocols
//
// This build supports Moonraker/Klipper only (printer.Kind == "fdm_klipper").
// All other kinds cause an immediate failed{unsupported-protocol} report with no
// network activity.
//
// # "we sent the file ≠ the print failed" contract
//
// After a successful Dispatch the handler calls moonraker.Subscribe to watch
// the print to terminal.  If Subscribe returns an error (websocket drop, network
// blip, courier restart) the handler logs the error and returns it — which tells
// RunClaimLoop to log it — but does NOT post a failed status report.  The job
// remains in "dispatched" state server-side.  Server-side reconciliation or a
// future courier reconnect is responsible for deciding the final outcome.
package agent

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers/moonraker"
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
//  1. Routes by bundle.Printer.Kind — only "fdm_klipper" is handled; all other
//     kinds → failed{unsupported-protocol}.
//  2. Parses ConnectionConfig and Credential (nil credential is valid).
//  3. Dispatches the artifact via moonraker.Dispatch.
//  4. On success: posts dispatched{remote_filename} and then calls
//     moonraker.Subscribe.  Subscribe errors are returned (not a failed report).
//  5. On dispatch failure: posts failed{reason, details} and returns nil.
func MakeJobHandler(
	client *central.Client,
	density, diameter float64,
	log *slog.Logger,
) JobHandler {
	return func(ctx context.Context, bundle *central.ClaimBundle, artifactPath string) error {
		jobID := bundle.Job.ID

		// ------------------------------------------------------------------
		// 1. Route by printer kind.
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

		if bundle.Printer.Kind != moonrakerKind {
			log.Warn("orchestrator: unsupported printer kind",
				"job_id", jobID,
				"kind", bundle.Printer.Kind,
			)
			if err := client.ReportStatus(ctx, central.FailedReport(
				jobID,
				"unsupported-protocol",
				"courier supports moonraker only in this build",
			)); err != nil {
				log.Warn("orchestrator: failed to report status", "job_id", jobID, "error", err)
			}
			return nil // not a handler error; the failure was reported
		}

		// ------------------------------------------------------------------
		// 2. Parse ConnectionConfig and Credential.
		// ------------------------------------------------------------------
		connCfg, err := moonraker.ParseConnectionConfig(bundle.Printer.ConnectionConfig)
		if err != nil {
			log.Error("orchestrator: parse connection_config failed",
				"job_id", jobID, "error", err)
			if rerr := client.ReportStatus(ctx, central.FailedReport(
				jobID,
				"unknown",
				fmt.Sprintf("parse connection_config: %s", err.Error()),
			)); rerr != nil {
				log.Warn("orchestrator: failed to report status", "job_id", jobID, "error", rerr)
			}
			return nil
		}

		var credPtr *moonraker.Credential
		if bundle.Credential != nil {
			cred, cerr := moonraker.ParseCredential(bundle.Credential.Payload)
			if cerr != nil {
				log.Error("orchestrator: parse credential failed",
					"job_id", jobID, "error", cerr)
				if rerr := client.ReportStatus(ctx, central.FailedReport(
					jobID,
					"unknown",
					fmt.Sprintf("parse credential: %s", cerr.Error()),
				)); rerr != nil {
					log.Warn("orchestrator: failed to report status", "job_id", jobID, "error", rerr)
				}
				return nil
			}
			credPtr = &cred
		}

		// ------------------------------------------------------------------
		// 3. Dispatch the artifact.
		// ------------------------------------------------------------------
		outcome := moonraker.Dispatch(ctx, connCfg, credPtr, artifactPath, nil, log)

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
			return nil // dispatch failure is reported; no Subscribe to attempt
		}

		// ------------------------------------------------------------------
		// 4. Report dispatched.
		// ------------------------------------------------------------------
		if rerr := client.ReportStatus(ctx, central.DispatchedReport(jobID, outcome.RemoteFilename)); rerr != nil {
			// Non-fatal: log and continue to Subscribe anyway.
			log.Warn("orchestrator: failed to report dispatched",
				"job_id", jobID,
				"remote_filename", outcome.RemoteFilename,
				"error", rerr,
			)
		}

		// ------------------------------------------------------------------
		// 5. Subscribe to the print status feed.
		//
		// A Subscribe error (connection drop, etc.) is returned so RunClaimLoop
		// can log it.  We do NOT post a failed report — the file was already
		// sent to the printer.  "we sent the file ≠ the print failed."
		// ------------------------------------------------------------------
		log.Info("orchestrator: subscribing to print status",
			"job_id", jobID,
			"remote_filename", outcome.RemoteFilename,
		)
		if serr := moonraker.Subscribe(ctx, connCfg, credPtr, jobID, client, density, diameter, log); serr != nil {
			log.Warn("orchestrator: status feed dropped — job remains dispatched server-side",
				"job_id", jobID,
				"error", serr,
			)
			return serr // caller (RunClaimLoop) logs; job stays in 'dispatched'
		}

		return nil
	}
}
