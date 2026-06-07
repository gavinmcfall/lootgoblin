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
