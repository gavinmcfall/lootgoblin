// Command courier is the lootgoblin courier agent.  It pairs with a central
// lootgoblin instance and dispatches print jobs to LAN printers.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/gavinmcfall/lootgoblin/courier/internal/agent"
	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/config"
	"github.com/gavinmcfall/lootgoblin/courier/internal/logging"
	"github.com/gavinmcfall/lootgoblin/courier/internal/pairing"
	"github.com/gavinmcfall/lootgoblin/courier/internal/version"
)

func main() {
	os.Exit(run())
}

// printVersion writes the version string to w.  Extracted so it is unit-testable
// without spawning a subprocess.
func printVersion(w io.Writer) {
	fmt.Fprintln(w, version.String())
}

// run is the real entry point; it returns an exit code so main stays trivial.
func run() int {
	// ------------------------------------------------------------------
	// 0. Version subcommand / flag — must work without a valid config.
	// ------------------------------------------------------------------
	if len(os.Args) > 1 {
		arg := os.Args[1]
		if arg == "version" || arg == "--version" || arg == "-v" {
			printVersion(os.Stdout)
			return 0
		}
	}

	log := logging.NewLogger()

	// ------------------------------------------------------------------
	// 1. Load config.
	// ------------------------------------------------------------------
	cfg, err := config.Load()
	if err != nil {
		log.Error("courier failed to start", "error", err)
		return 1
	}

	log.Info("courier starting",
		"version", version.Version,
		"server_url", cfg.ServerURL,
		"name", cfg.Name,
	)

	// ------------------------------------------------------------------
	// 2. Bootstrap client (may have empty API key before pairing).
	// ------------------------------------------------------------------
	client := central.New(cfg.ServerURL, cfg.APIKey, version.Version, nil)

	// ------------------------------------------------------------------
	// 3. Pairing: resolve or exchange for a long-lived API key.
	// ------------------------------------------------------------------
	statePath := statePath()
	apiKey, agentID, err := pairing.EnsurePaired(
		context.Background(),
		cfg,
		client,
		statePath,
		os.Stdin,
		log,
	)
	if err != nil {
		log.Error("pairing failed — cannot start", "error", err)
		return 1
	}
	_ = agentID // carried in state file; logged by EnsurePaired

	// ------------------------------------------------------------------
	// 4. Rebuild client with the resolved API key if it changed.
	// ------------------------------------------------------------------
	if apiKey != cfg.APIKey {
		client = central.New(cfg.ServerURL, apiKey, version.Version, nil)
	}

	// ------------------------------------------------------------------
	// 5. Root context cancelled on SIGINT / SIGTERM.
	// ------------------------------------------------------------------
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ------------------------------------------------------------------
	// 6. Temp dir for artifact downloads.
	// ------------------------------------------------------------------
	tempDir, err := os.MkdirTemp("", "courier-*")
	if err != nil {
		log.Error("failed to create temp dir", "error", err)
		return 1
	}
	defer os.RemoveAll(tempDir)

	// ------------------------------------------------------------------
	// 7. Start RunHeartbeat and RunClaimLoop concurrently.
	// ------------------------------------------------------------------
	handler := agent.MakeJobHandler(
		client,
		cfg.DefaultFilamentDensityGCm3,
		cfg.DefaultFilamentDiameterMm,
		log,
	)

	// loopErr collects fatal errors from the two goroutines.
	type result struct {
		name string
		err  error
	}
	resultCh := make(chan result, 2)

	var wg sync.WaitGroup
	wg.Add(2)

	// Heartbeat goroutine.
	go func() {
		defer wg.Done()
		err := agent.RunHeartbeat(ctx, client, cfg.HeartbeatIntervalSeconds, log)
		resultCh <- result{name: "heartbeat", err: err}
	}()

	// Claim-loop goroutine.
	go func() {
		defer wg.Done()
		err := agent.RunClaimLoop(ctx, client, cfg.ClaimPollIntervalSeconds, tempDir, handler, log)
		resultCh <- result{name: "claim-loop", err: err}
	}()

	// Wait for the first goroutine to finish and decide what to do.
	// We close resultCh after both goroutines are done so the drain loop below
	// terminates.
	go func() {
		wg.Wait()
		close(resultCh)
	}()

	exitCode := 0
	cancelCalled := false

	for res := range resultCh {
		if res.err == nil || errors.Is(res.err, context.Canceled) || errors.Is(res.err, context.DeadlineExceeded) {
			// Clean stop (signal or ctx cancellation) — not an error.
			continue
		}

		// Version-incompatible is fatal: log a clear upgrade message and halt.
		if errors.Is(res.err, central.ErrVersionIncompatible) {
			log.Error("courier must be upgraded before it can continue",
				"loop", res.name,
				"error", res.err,
			)
			fmt.Fprintln(os.Stderr,
				"FATAL: courier version is incompatible with the server. "+
					"Please upgrade the courier container to a compatible version.")
			exitCode = 1
			if !cancelCalled {
				stop()
				cancelCalled = true
			}
			continue
		}

		// Any other unexpected error from a loop.
		log.Error("courier loop terminated with unexpected error",
			"loop", res.name,
			"error", res.err,
		)
		exitCode = 1
		if !cancelCalled {
			stop()
			cancelCalled = true
		}
	}

	if exitCode == 0 {
		log.Info("courier stopped cleanly")
	}
	return exitCode
}

// statePath returns the path where the courier persists its pairing state.
// It can be overridden via the COURIER_STATE_PATH environment variable; the
// default matches the Docker container's /config volume.
func statePath() string {
	if p := os.Getenv("COURIER_STATE_PATH"); p != "" {
		return p
	}
	return "/config/courier-state.json"
}
