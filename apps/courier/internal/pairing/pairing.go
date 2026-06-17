// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package pairing implements the one-time pairing flow that exchanges a
// short-lived pair token for a long-lived API key.  On success the key, agent
// ID, and instance ID are persisted to a 0600 JSON state file so subsequent
// starts skip the network round-trip.
package pairing

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"

	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/config"
	"github.com/gavinmcfall/lootgoblin/courier/internal/state"
)

// EnsurePaired returns the long-lived API key and agent ID for this courier,
// running the pairing handshake if needed.
//
// Decision tree:
//  1. cfg.APIKey is non-empty → already paired; return it immediately without
//     touching the server.
//  2. Resolve a pair token: cfg.PairToken if set, else one line from promptIn.
//     Empty token → error.
//  3. Call client.Pair; on success persist to statePath (0600 JSON).
//  4. On ErrInvalidPairToken → wrap with carried reason; on ErrPairTokenUsed →
//     clear actionable error.  Neither failure persists anything.
func EnsurePaired(
	ctx context.Context,
	cfg *config.Config,
	client *central.Client,
	statePath string,
	promptIn io.Reader,
	log *slog.Logger,
) (apiKey, agentID string, err error) {
	// --- Already paired ---
	if cfg.APIKey != "" {
		log.InfoContext(ctx, "pairing: already paired, skipping handshake")
		// Also surface the persisted agent ID if the state file exists.
		s, loadErr := state.Load(statePath)
		if loadErr != nil {
			// Non-fatal: we have the key; just log and continue.
			log.WarnContext(ctx, "pairing: could not load state file", "error", loadErr)
		}
		return cfg.APIKey, s.AgentID, nil
	}

	// --- Resolve the pair token ---
	token, err := resolveToken(cfg.PairToken, promptIn)
	if err != nil {
		return "", "", err
	}

	log.InfoContext(ctx, "pairing: calling central pair endpoint", "name", cfg.Name)

	// --- Call the server ---
	result, err := client.Pair(ctx, token, cfg.Name, "")
	if err != nil {
		return "", "", classifyPairError(err)
	}

	// --- Persist ---
	s := state.State{
		APIKey:     result.APIKey,
		AgentID:    result.AgentID,
		InstanceID: result.InstanceID,
	}
	if saveErr := state.Save(statePath, s); saveErr != nil {
		// Persistence failure is non-fatal: log and continue.  The caller will
		// re-pair on next start, but this run can proceed.
		log.WarnContext(ctx, "pairing: could not persist state", "error", saveErr, "path", statePath)
	} else {
		log.InfoContext(ctx, "pairing: state persisted", "path", statePath, "agent_id", result.AgentID)
	}

	return result.APIKey, result.AgentID, nil
}

// resolveToken returns the pair token to use.  If explicit is non-empty it is
// returned directly.  Otherwise one line is read from r (interactive stdin).
func resolveToken(explicit string, r io.Reader) (string, error) {
	if explicit != "" {
		return strings.TrimSpace(explicit), nil
	}

	// Interactive read: consume exactly one line.
	scanner := bufio.NewScanner(r)
	if scanner.Scan() {
		t := strings.TrimSpace(scanner.Text())
		if t != "" {
			return t, nil
		}
	}

	return "", errors.New("no pair token: set pair_token / COURIER_PAIR_TOKEN or enter one interactively")
}

// classifyPairError converts well-known central errors into user-facing
// messages while wrapping unknown errors with the "pairing:" prefix.
func classifyPairError(err error) error {
	var pte *central.PairTokenError
	if errors.As(err, &pte) {
		return fmt.Errorf("pairing: invalid pair token (%s)", pte.Reason)
	}
	if errors.Is(err, central.ErrPairTokenUsed) {
		return errors.New("pairing: pair token already used — generate a new one")
	}
	return fmt.Errorf("pairing: %w", err)
}
