// Package config loads and validates the environment supplied to the API.
package config

import (
	"errors"
	"os"
	"strings"
)

// Config contains infrastructure settings only. Application data never comes
// from environment variables.
type Config struct {
	DatabaseURL string
	BaseURL     string
	Port        string
}

// Load reads a complete, runnable configuration from the process environment.
func Load() (Config, error) {
	cfg := Config{
		DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")),
		BaseURL:     strings.TrimRight(strings.TrimSpace(os.Getenv("APP_BASE_URL")), "/"),
		Port:        strings.TrimSpace(os.Getenv("PORT")),
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://localhost:8080"
	}
	if cfg.Port == "" {
		cfg.Port = "8080"
	}
	return cfg, nil
}
