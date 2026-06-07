// Command courier is the lootgoblin courier agent.  It pairs with a central
// lootgoblin instance and dispatches print jobs to LAN printers.
//
// This file is the entrypoint: load config, initialise the structured logger,
// and log a startup line.  The run loops are added in later tasks.
package main

import (
	"os"

	"github.com/gavinmcfall/lootgoblin/courier/internal/config"
	"github.com/gavinmcfall/lootgoblin/courier/internal/logging"
	"github.com/gavinmcfall/lootgoblin/courier/internal/version"
)

func main() {
	log := logging.NewLogger()

	cfg, err := config.Load()
	if err != nil {
		log.Error("courier failed to start", "error", err)
		os.Exit(1)
	}

	log.Info("courier starting",
		"version", version.Version,
		"server_url", cfg.ServerURL,
	)
}
