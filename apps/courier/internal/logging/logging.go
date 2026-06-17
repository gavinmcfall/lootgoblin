// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package logging provides a shared logger constructor for the courier binary.
package logging

import (
	"log/slog"
	"os"
)

// NewLogger returns a JSON slog.Logger writing to stderr.
func NewLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stderr, nil))
}
