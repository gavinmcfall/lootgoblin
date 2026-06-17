// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

package chitu

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// Polling state machine types + constants
// ---------------------------------------------------------------------------

// PollingState is the M27 state machine state for a ChituNetwork printer.
type PollingState int

const (
	StateIdle           PollingState = iota // poll every 60s
	StatePrinting                           // poll every 10s; emit progress
	StateNearCompletion                     // poll every 2s; emit progress
	StateJustFinished                       // poll every 30s for 5 min; emitted completed once on entry
	StateOffline                            // exp backoff; recover on first successful M27
)

const (
	pollIntervalIdle           = 60 * time.Second
	pollIntervalPrinting       = 10 * time.Second
	pollIntervalNearCompletion = 2 * time.Second
	pollIntervalJustFinished   = 30 * time.Second
	pollIntervalOfflineInitial = 60 * time.Second
	pollIntervalOfflineCap     = 5 * 60 * time.Second

	nearCompletionThresholdPct = 90
	justFinishedDuration       = 5 * 60 * time.Second
	offlineFailureThreshold    = 5

	m27ReplyTimeout = 5 * time.Second
)

// ---------------------------------------------------------------------------
// M27 reply parser — pure
// ---------------------------------------------------------------------------

// M27Reply represents a parsed M27 response.
type M27Reply struct {
	IsPrinting   bool
	BytesPrinted int
	TotalBytes   int
}

var printRE = regexp.MustCompile(`(?i)^Print:\s*(\d+)\s*/\s*(\d+)`)

// ParseM27Reply parses one M27 reply line.
// Returns (reply, true) on success; (zero, false) if the line is unrecognised.
func ParseM27Reply(line string) (M27Reply, bool) {
	trimmed := strings.TrimSpace(line)
	if m := printRE.FindStringSubmatch(trimmed); m != nil {
		bp, err1 := strconv.Atoi(m[1])
		tb, err2 := strconv.Atoi(m[2])
		if err1 != nil || err2 != nil || bp < 0 || tb < 0 {
			return M27Reply{}, false
		}
		return M27Reply{IsPrinting: true, BytesPrinted: bp, TotalBytes: tb}, true
	}
	if strings.Contains(strings.ToLower(trimmed), "not currently printing") {
		return M27Reply{IsPrinting: false}, true
	}
	return M27Reply{}, false
}

// ---------------------------------------------------------------------------
// Offline-interval calculator — pure
// ---------------------------------------------------------------------------

// ComputeOfflineInterval returns the backoff interval for the OFFLINE state
// given the number of consecutive failures.
//
//	5 failures → 60s; 6 → 120s; 7 → 240s; 8+ → 300s (cap)
func ComputeOfflineInterval(failures int) time.Duration {
	offlineFailures := failures - offlineFailureThreshold
	if offlineFailures < 0 {
		offlineFailures = 0
	}
	// Use int64 seconds to avoid overflow when offlineFailures is large.
	baseSec := int64(pollIntervalOfflineInitial / time.Second)
	capSec := int64(pollIntervalOfflineCap / time.Second)
	sec := baseSec
	for i := 0; i < offlineFailures; i++ {
		sec *= 2
		if sec > capSec {
			sec = capSec
			break
		}
	}
	if sec > capSec {
		sec = capSec
	}
	return time.Duration(sec) * time.Second
}

// ---------------------------------------------------------------------------
// NextState — pure state transition function
// ---------------------------------------------------------------------------

// NextState returns the next polling state given current state and M27 reply.
// A failed poll (IsPrinting=false, ok=false from ParseM27Reply) is represented
// by ok=false; pass ok=false to leave the state unchanged (failure is handled
// by the loop via consecutiveFailures).
func NextState(current PollingState, reply M27Reply, ok bool) PollingState {
	if current == StateOffline {
		return current // OFFLINE exit is governed by the loop, not NextState
	}
	if !ok {
		return current // unrecognised line — stay
	}
	if !reply.IsPrinting {
		// "Not currently printing"
		switch current {
		case StatePrinting, StateNearCompletion:
			return StateJustFinished
		case StateJustFinished:
			return StateJustFinished // stay until 5-min timer fires
		default:
			return StateIdle
		}
	}
	// IsPrinting == true
	if reply.TotalBytes == 0 {
		return current
	}
	pct := float64(reply.BytesPrinted) / float64(reply.TotalBytes) * 100
	if pct >= nearCompletionThresholdPct {
		return StateNearCompletion
	}
	if reply.BytesPrinted > 0 {
		return StatePrinting
	}
	// bytesPrinted == 0: printer reports a job loaded but not started.
	if current == StateJustFinished {
		return StateJustFinished
	}
	return StateIdle
}

// ---------------------------------------------------------------------------
// pollFunc abstraction — injectable for tests
// ---------------------------------------------------------------------------

// PollFunc sends M27 and returns the parsed reply.
// Returns (reply, true) on success; (zero, false) on transport error or
// unrecognised reply.
type PollFunc func() (M27Reply, bool)

// ---------------------------------------------------------------------------
// Subscribe — M27 polling loop
// ---------------------------------------------------------------------------

// Subscribe connects to a ChituNetwork printer and polls M27 until ctx is
// cancelled or a terminal error occurs.
//
// dialFn is injectable for tests; pass nil to use net.Dial.
// sleepFn is injectable for tests; pass nil to use time.Sleep.
//
// Contract: a dropped TCP connection must NOT post a failed report.
func Subscribe(
	ctx context.Context,
	cfg ConnectionConfig,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
	dialFn func(addr string) (Conn, error),
	sleepFn func(d time.Duration),
) error {
	if log == nil {
		log = slog.Default()
	}
	if sleepFn == nil {
		sleepFn = time.Sleep
	}
	if dialFn == nil {
		dialFn = func(addr string) (Conn, error) {
			return net.DialTimeout("tcp", addr, 10*time.Second)
		}
	}

	addr := fmt.Sprintf("%s:%d", cfg.IP, cfg.Port)
	conn, err := dialFn(addr)
	if err != nil {
		// Treat initial connect failure as unreachable (log only; no failed report).
		log.Warn("chitu-status: dial failed", "addr", addr, "err", err)
		return fmt.Errorf("chitu-status: dial %s: %w", addr, err)
	}
	defer conn.Close()

	log.Info("chitu-status: connected", "addr", addr, "jobID", jobID)

	poll := makePollFn(conn)
	return runLoop(ctx, cfg, jobID, reporter, log, poll, sleepFn)
}

// makePollFn builds a PollFunc over an open Conn.
func makePollFn(conn Conn) PollFunc {
	return func() (M27Reply, bool) {
		if err := conn.SetDeadline(time.Now().Add(m27ReplyTimeout)); err != nil {
			return M27Reply{}, false
		}
		if _, err := fmt.Fprintf(conn, "M27\n"); err != nil {
			return M27Reply{}, false
		}
		line, err := readLine(conn)
		if err != nil {
			return M27Reply{}, false
		}
		return ParseM27Reply(line)
	}
}

// runLoop is the inner polling loop, separated for testability (tests inject
// pollFn and sleepFn directly without a real TCP connection).
func runLoop(
	ctx context.Context,
	cfg ConnectionConfig,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
	poll PollFunc,
	sleepFn func(d time.Duration),
) error {
	if log == nil {
		log = slog.Default()
	}
	state := StateIdle
	consecutiveFailures := 0
	justFinishedEntry := time.Time{}
	completedEmitted := false

	intervalFor := func() time.Duration {
		switch state {
		case StateIdle:
			return pollIntervalIdle
		case StatePrinting:
			return pollIntervalPrinting
		case StateNearCompletion:
			return pollIntervalNearCompletion
		case StateJustFinished:
			return pollIntervalJustFinished
		case StateOffline:
			return ComputeOfflineInterval(consecutiveFailures)
		default:
			return pollIntervalIdle
		}
	}

	for {
		// Respect context cancellation between polls.
		select {
		case <-ctx.Done():
			log.Info("chitu-status: context cancelled", "jobID", jobID)
			return ctx.Err()
		default:
		}

		reply, ok := poll()

		if !ok {
			// M27 failed.
			consecutiveFailures++
			if consecutiveFailures >= offlineFailureThreshold && state != StateOffline {
				log.Warn("chitu-status: transitioning to OFFLINE",
					"jobID", jobID, "consecutiveFailures", consecutiveFailures)
				state = StateOffline
				// Emit unreachable event (once on transition edge).
				_ = reporter.ReportStatus(ctx, central.StatusEventReport(jobID,
					central.StatusEventPayload{
						Kind:         "unreachable",
						RemoteJobRef: "",
						OccurredAt:   time.Now().UTC().Format(time.RFC3339),
					}))
			}
		} else {
			// Successful M27 reply.
			if consecutiveFailures > 0 {
				log.Info("chitu-status: M27 succeeded — clearing failure counter",
					"jobID", jobID, "prevFailures", consecutiveFailures)
				consecutiveFailures = 0
			}
			if state == StateOffline {
				state = StateIdle
			}

			prev := state
			state = NextState(state, reply, ok)

			// Emit events.
			if (state == StatePrinting || state == StateNearCompletion) &&
				reply.IsPrinting && reply.TotalBytes > 0 {
				pct := float64(reply.BytesPrinted) / float64(reply.TotalBytes) * 100
				rounded := float64(int(pct + 0.5))
				_ = reporter.ReportStatus(ctx, central.StatusEventReport(jobID,
					central.StatusEventPayload{
						Kind:         "progress",
						RemoteJobRef: "",
						ProgressPct:  &rounded,
						RawPayload: map[string]any{
							"bytesPrinted": reply.BytesPrinted,
							"totalBytes":   reply.TotalBytes,
						},
						OccurredAt: time.Now().UTC().Format(time.RFC3339),
					}))
			} else if state == StateJustFinished &&
				(prev == StatePrinting || prev == StateNearCompletion) &&
				!completedEmitted {
				// Emit completed ONCE on entry from a live print state.
				completedEmitted = true
				justFinishedEntry = time.Now()
				pct := float64(100)
				_ = reporter.ReportStatus(ctx, central.StatusEventReport(jobID,
					central.StatusEventPayload{
						Kind:         "completed",
						RemoteJobRef: "",
						ProgressPct:  &pct,
						OccurredAt:   time.Now().UTC().Format(time.RFC3339),
					}))
				_ = reporter.ReportStatus(ctx, central.CompletedReport(jobID, nil))
			}
		}

		// JUST_FINISHED 5-minute exit.
		if state == StateJustFinished && !justFinishedEntry.IsZero() {
			if time.Since(justFinishedEntry) >= justFinishedDuration {
				log.Info("chitu-status: JUST_FINISHED window elapsed, returning to IDLE",
					"jobID", jobID)
				state = StateIdle
				justFinishedEntry = time.Time{}
				completedEmitted = false
			}
		}

		interval := intervalFor()
		select {
		case <-ctx.Done():
			log.Info("chitu-status: context cancelled", "jobID", jobID)
			return ctx.Err()
		default:
			sleepFn(interval)
		}
	}
}

// NotifyPrinting is a signal from the dispatcher: M6030 was sent successfully.
// This is conceptual documentation — the actual hook is implemented in the
// orchestrator by connecting Dispatch → Subscribe with a channel; in the Go
// port the polling loop checks the notifyPrinting channel at the start of each
// sleep if provided.
//
// For the Courier's current architecture (sequential Dispatch then Subscribe),
// this is handled by SubscribeWithNotify.
func SubscribeWithNotify(
	ctx context.Context,
	cfg ConnectionConfig,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
	dialFn func(addr string) (Conn, error),
	sleepFn func(d time.Duration),
	notifyPrinting <-chan struct{},
) error {
	if log == nil {
		log = slog.Default()
	}
	if sleepFn == nil {
		sleepFn = time.Sleep
	}
	if dialFn == nil {
		dialFn = func(addr string) (Conn, error) {
			return net.DialTimeout("tcp", addr, 10*time.Second)
		}
	}

	addr := fmt.Sprintf("%s:%d", cfg.IP, cfg.Port)
	conn, err := dialFn(addr)
	if err != nil {
		log.Warn("chitu-status: dial failed", "addr", addr, "err", err)
		return fmt.Errorf("chitu-status: dial %s: %w", addr, err)
	}
	defer conn.Close()

	log.Info("chitu-status: connected", "addr", addr, "jobID", jobID)

	poll := makePollFn(conn)
	return runLoopWithNotify(ctx, cfg, jobID, reporter, log, poll, sleepFn, notifyPrinting)
}

// runLoopWithNotify is the polling loop with a notifyPrinting channel for
// IDLE→PRINTING forced transition.
func runLoopWithNotify(
	ctx context.Context,
	cfg ConnectionConfig,
	jobID string,
	reporter printers.Reporter,
	log *slog.Logger,
	poll PollFunc,
	sleepFn func(d time.Duration),
	notifyPrinting <-chan struct{},
) error {
	if log == nil {
		log = slog.Default()
	}
	state := StateIdle
	consecutiveFailures := 0
	justFinishedEntry := time.Time{}
	completedEmitted := false

	intervalFor := func() time.Duration {
		switch state {
		case StateIdle:
			return pollIntervalIdle
		case StatePrinting:
			return pollIntervalPrinting
		case StateNearCompletion:
			return pollIntervalNearCompletion
		case StateJustFinished:
			return pollIntervalJustFinished
		case StateOffline:
			return ComputeOfflineInterval(consecutiveFailures)
		default:
			return pollIntervalIdle
		}
	}

	emitProgress := func(reply M27Reply) {
		if reply.TotalBytes == 0 {
			return
		}
		pct := float64(reply.BytesPrinted) / float64(reply.TotalBytes) * 100
		rounded := float64(int(pct + 0.5))
		_ = reporter.ReportStatus(ctx, central.StatusEventReport(jobID,
			central.StatusEventPayload{
				Kind:         "progress",
				RemoteJobRef: "",
				ProgressPct:  &rounded,
				RawPayload: map[string]any{
					"bytesPrinted": reply.BytesPrinted,
					"totalBytes":   reply.TotalBytes,
				},
				OccurredAt: time.Now().UTC().Format(time.RFC3339),
			}))
	}

	emitCompleted := func() {
		if completedEmitted {
			return
		}
		completedEmitted = true
		justFinishedEntry = time.Now()
		pct := float64(100)
		_ = reporter.ReportStatus(ctx, central.StatusEventReport(jobID,
			central.StatusEventPayload{
				Kind:         "completed",
				RemoteJobRef: "",
				ProgressPct:  &pct,
				OccurredAt:   time.Now().UTC().Format(time.RFC3339),
			}))
		_ = reporter.ReportStatus(ctx, central.CompletedReport(jobID, nil))
	}

	for {
		// Check for notifyPrinting signal (IDLE→PRINTING forced transition).
		if notifyPrinting != nil {
			select {
			case <-notifyPrinting:
				if state == StateIdle {
					log.Info("chitu-status: notifyPrinting received, forcing IDLE→PRINTING",
						"jobID", jobID)
					state = StatePrinting
				}
			default:
			}
		}

		select {
		case <-ctx.Done():
			log.Info("chitu-status: context cancelled", "jobID", jobID)
			return ctx.Err()
		default:
		}

		reply, ok := poll()

		if !ok {
			consecutiveFailures++
			if consecutiveFailures >= offlineFailureThreshold && state != StateOffline {
				log.Warn("chitu-status: transitioning to OFFLINE",
					"jobID", jobID, "consecutiveFailures", consecutiveFailures)
				state = StateOffline
				_ = reporter.ReportStatus(ctx, central.StatusEventReport(jobID,
					central.StatusEventPayload{
						Kind:         "unreachable",
						RemoteJobRef: "",
						OccurredAt:   time.Now().UTC().Format(time.RFC3339),
					}))
			}
		} else {
			if consecutiveFailures > 0 {
				log.Info("chitu-status: M27 recovered",
					"jobID", jobID, "prevFailures", consecutiveFailures)
				consecutiveFailures = 0
			}
			if state == StateOffline {
				state = StateIdle
			}

			prev := state
			state = NextState(state, reply, ok)

			switch {
			case state == StatePrinting || state == StateNearCompletion:
				if reply.IsPrinting {
					emitProgress(reply)
				}
			case state == StateJustFinished && (prev == StatePrinting || prev == StateNearCompletion):
				emitCompleted()
			}
		}

		// JUST_FINISHED 5-minute exit.
		if state == StateJustFinished && !justFinishedEntry.IsZero() {
			if time.Since(justFinishedEntry) >= justFinishedDuration {
				state = StateIdle
				justFinishedEntry = time.Time{}
				completedEmitted = false
			}
		}

		interval := intervalFor()
		select {
		case <-ctx.Done():
			log.Info("chitu-status: context cancelled", "jobID", jobID)
			return ctx.Err()
		default:
			sleepFn(interval)
		}
	}
}
