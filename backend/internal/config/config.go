// Package config loads and validates the environment supplied to the API.
package config

import (
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config contains infrastructure settings only. Application data never comes
// from environment variables.
type Config struct {
	DatabaseURL      string
	BaseURL          string
	Port             string
	DatabaseMaxConns int
}

// Load reads a complete, runnable configuration from the process environment.
func Load() (Config, error) {
	cfg := Config{
		DatabaseURL:      strings.TrimSpace(os.Getenv("DATABASE_URL")),
		BaseURL:          strings.TrimRight(strings.TrimSpace(os.Getenv("APP_BASE_URL")), "/"),
		Port:             strings.TrimSpace(os.Getenv("PORT")),
		DatabaseMaxConns: 10,
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("DATABASE_URL is required")
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://localhost:8080"
	}
	parsedURL, err := url.Parse(cfg.BaseURL)
	if err != nil || parsedURL.Scheme == "" || parsedURL.Host == "" || parsedURL.RawQuery != "" || parsedURL.Fragment != "" {
		return Config{}, errors.New("APP_BASE_URL must be an absolute URL without query or fragment")
	}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("GIN_MODE")), "release") && parsedURL.Scheme != "https" {
		return Config{}, errors.New("APP_BASE_URL must use HTTPS when GIN_MODE=release")
	}
	if cfg.Port == "" {
		cfg.Port = "8080"
	}
	if raw := strings.TrimSpace(os.Getenv("DATABASE_MAX_CONNS")); raw != "" {
		maxConns, err := strconv.Atoi(raw)
		if err != nil || maxConns < 1 || maxConns > 50 {
			return Config{}, errors.New("DATABASE_MAX_CONNS must be an integer from 1 to 50")
		}
		cfg.DatabaseMaxConns = maxConns
	}
	return cfg, nil
}
