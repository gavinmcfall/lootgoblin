package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
)

const (
	defaultClaimPollIntervalSeconds = 5
	maxBackoff                      = 60 * time.Second
)

// JobHandler executes a claimed job. bundle is non-nil; artifactPath is the
// verified local temp file. Returning an error means execution failed AFTER
// a successful claim+download (the handler itself reports the failure status).
type JobHandler func(ctx context.Context, bundle *central.ClaimBundle, artifactPath string) error

// RunClaimLoop polls the central instance for jobs, downloads and verifies
// artifacts, and hands verified jobs to the handle callback.
//
// Return behaviour:
//   - ctx cancelled → returns ctx.Err().
//   - Any claim error → logs at warn, backs off, continues (transient).
//
// If intervalSeconds <= 0 the default of 5 seconds is used.
func RunClaimLoop(ctx context.Context, client *central.Client, intervalSeconds int, tempDir string, handle JobHandler, log *slog.Logger) error {
	if intervalSeconds <= 0 {
		intervalSeconds = defaultClaimPollIntervalSeconds
	}
	return runClaim(ctx, client, time.Duration(intervalSeconds)*time.Second, tempDir, handle, log)
}

// runClaim is the testable inner loop. Tests call it directly with millisecond
// durations so timing checks stay sub-second.
func runClaim(ctx context.Context, client *central.Client, base time.Duration, tempDir string, handle JobHandler, log *slog.Logger) error {
	backoff := base

	for {
		// Check for cancellation before each poll.
		if ctx.Err() != nil {
			return ctx.Err()
		}

		bundle, err := client.Claim(ctx)
		if err != nil {
			// Check for context cancellation first.
			if ctx.Err() != nil {
				return ctx.Err()
			}
			log.Warn("claim poll failed (transient)", "error", err)
			if err := sleepContext(ctx, backoff); err != nil {
				return err
			}
			backoff = minDuration(backoff*2, maxBackoff)
			continue
		}

		if bundle == nil {
			// No job available — back off.
			if err := sleepContext(ctx, backoff); err != nil {
				return err
			}
			backoff = minDuration(backoff*2, maxBackoff)
			continue
		}

		// Job claimed — reset backoff to base.
		backoff = base

		if err := processBundle(ctx, client, bundle, tempDir, handle, log); err != nil {
			// Context cancellation during processing — exit cleanly.
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// processBundle already logged the error; continue polling.
		}
	}
}

// processBundle downloads, verifies, and dispatches a single ClaimBundle.
// It handles its own cleanup and status reporting.
func processBundle(ctx context.Context, client *central.Client, bundle *central.ClaimBundle, tempDir string, handle JobHandler, log *slog.Logger) error {
	if bundle.Artifact == nil {
		log.Error("claim bundle has no artifact", "job_id", bundle.Job.ID)
		reportFailed(ctx, client, bundle.Job.ID, "rejected", "no-artifact", log)
		return fmt.Errorf("claim bundle %s has no artifact", bundle.Job.ID)
	}

	// Create a temp file to receive the artifact bytes.
	f, err := os.CreateTemp(tempDir, "artifact-*")
	if err != nil {
		log.Error("failed to create temp file for artifact",
			"job_id", bundle.Job.ID, "error", err)
		reportFailed(ctx, client, bundle.Job.ID, "rejected", "temp-file-create-failed", log)
		return err
	}
	artifactPath := f.Name()
	// Always clean up the temp file when we're done.
	defer os.Remove(artifactPath)

	// Stream the artifact while simultaneously computing the SHA-256 hash.
	h := sha256.New()
	mw := io.MultiWriter(f, h)

	sha256Header, err := client.DownloadArtifact(ctx, bundle.Artifact.JobID, mw)
	closeErr := f.Close() // Close before further use regardless of download result.
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Error("artifact download failed",
			"job_id", bundle.Job.ID, "error", err)
		reportFailed(ctx, client, bundle.Job.ID, "rejected", "artifact-download-failed", log)
		return err
	}
	if closeErr != nil {
		log.Error("artifact temp file close failed",
			"job_id", bundle.Job.ID, "error", closeErr)
		reportFailed(ctx, client, bundle.Job.ID, "rejected", "artifact-write-failed", log)
		return closeErr
	}

	// Verify computed digest against the bundle's expected SHA-256.
	computed := hex.EncodeToString(h.Sum(nil))
	if computed != bundle.Artifact.SHA256 {
		log.Error("artifact SHA-256 mismatch",
			"job_id", bundle.Job.ID,
			"expected", bundle.Artifact.SHA256,
			"computed", computed,
			"header", sha256Header,
		)
		reportFailed(ctx, client, bundle.Job.ID, "rejected", "artifact-sha-mismatch", log)
		return fmt.Errorf("artifact-sha-mismatch for job %s", bundle.Job.ID)
	}

	// Call the handler. The handler is responsible for reporting its own failure
	// status if it returns an error; B5 just logs.
	if err := handle(ctx, bundle, artifactPath); err != nil {
		log.Error("job handler returned error",
			"job_id", bundle.Job.ID, "error", err)
		return err
	}

	return nil
}

// reportFailed attempts to post a failed status report, logging on error.
func reportFailed(ctx context.Context, client *central.Client, jobID, reason, details string, log *slog.Logger) {
	if ctx.Err() != nil {
		return
	}
	if err := client.ReportStatus(ctx, central.FailedReport(jobID, reason, details)); err != nil {
		log.Warn("failed to report job failure",
			"job_id", jobID, "reason", reason, "details", details, "error", err)
	}
}

// sleepContext sleeps for d, returning ctx.Err() if the context is cancelled
// before the sleep completes.
func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// minDuration returns the smaller of a and b.
func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
