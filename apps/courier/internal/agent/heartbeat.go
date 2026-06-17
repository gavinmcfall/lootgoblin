// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package agent contains the long-running loops that make up the courier
// agent runtime (heartbeat, job-claim, etc.).
package agent

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/version"
)

const defaultHeartbeatIntervalSeconds = 30

// RunHeartbeat sends a heartbeat to the central instance immediately and then
// on a repeating interval.  It self-tunes the interval if the server returns a
// different HeartbeatIntervalSeconds value.
//
// Return behaviour:
//   - ctx cancelled → returns ctx.Err() (callers treat this as a clean exit).
//   - ErrVersionIncompatible → logs at error and returns the error so the
//     caller (orchestrator) can treat it as fatal.
//   - Any other error → logs at warn and keeps looping (transient failure).
//
// If intervalSeconds <= 0 the default of 30 seconds is used.
func RunHeartbeat(ctx context.Context, client *central.Client, intervalSeconds int, log *slog.Logger) error {
	if intervalSeconds <= 0 {
		intervalSeconds = defaultHeartbeatIntervalSeconds
	}
	return run(ctx, client, time.Duration(intervalSeconds)*time.Second, log)
}

// run is the testable inner loop.  Tests call it directly with millisecond
// durations so timing checks stay sub-second.
func run(ctx context.Context, client *central.Client, interval time.Duration, log *slog.Logger) error {
	// Fire the first heartbeat immediately before starting the timer.
	if err := beat(ctx, client, &interval, log); err != nil {
		return err
	}

	// Use a Timer (not a Ticker) so we can reset it when the server-returned
	// interval differs from the current one.
	timer := time.NewTimer(interval)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()

		case <-timer.C:
			if err := beat(ctx, client, &interval, log); err != nil {
				return err
			}
			timer.Reset(interval)
		}
	}
}

// beat sends one heartbeat request and processes the result.
// It mutates *interval if the server requests a different cadence.
// It returns a non-nil error only for fatal conditions (ErrVersionIncompatible
// or ctx cancellation); transient errors are logged and swallowed.
func beat(ctx context.Context, client *central.Client, interval *time.Duration, log *slog.Logger) error {
	result, err := client.Heartbeat(ctx, central.HeartbeatRequest{
		CourierVersion: version.Version,
		Printers:       nil,
	})
	if err != nil {
		// Check for context cancellation first.
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Fatal: major version mismatch — extract carried ServerVersion and halt.
		if errors.Is(err, central.ErrVersionIncompatible) {
			var ve *central.VersionIncompatibleError
			errors.As(err, &ve)
			if ve != nil {
				log.Error("courier version incompatible with server — upgrade required",
					"server_version", ve.ServerVersion,
					"courier_version", version.Version,
					"action", ve.Action,
				)
			} else {
				log.Error("courier version incompatible with server — upgrade required",
					"courier_version", version.Version,
				)
			}
			return err
		}

		// Transient (network, 5xx, etc.) — log and continue looping.
		log.Warn("heartbeat failed (transient)", "error", err)
		return nil
	}

	// Successful heartbeat — check for advisory warning.
	if result.Warning != "" {
		log.Warn("heartbeat warning from server", "warning", result.Warning)
	}

	// Self-tune the interval if the server requested a different cadence.
	if result.HeartbeatIntervalSeconds > 0 {
		newInterval := time.Duration(result.HeartbeatIntervalSeconds) * time.Second
		if newInterval != *interval {
			log.Info("heartbeat interval updated by server",
				"old_seconds", int(interval.Seconds()),
				"new_seconds", result.HeartbeatIntervalSeconds,
			)
			*interval = newInterval
		}
	}

	return nil
}
