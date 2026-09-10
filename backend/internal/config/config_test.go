package config

import "testing"

func TestLoadReadsPoolLimit(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:password@localhost:5432/oi_bas")
	t.Setenv("APP_BASE_URL", "https://oi-bas.space/")
	t.Setenv("PORT", "8080")
	t.Setenv("DATABASE_MAX_CONNS", "12")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BaseURL != "https://oi-bas.space" || cfg.DatabaseMaxConns != 12 {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestLoadRejectsUnsafePoolLimit(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:password@localhost:5432/oi_bas")
	t.Setenv("DATABASE_MAX_CONNS", "0")

	if _, err := Load(); err == nil {
		t.Fatal("zero pool size was accepted")
	}
}

func TestLoadRequiresHTTPSInRelease(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://user:password@localhost:5432/oi_bas")
	t.Setenv("APP_BASE_URL", "http://oi-bas.space")
	t.Setenv("GIN_MODE", "release")

	if _, err := Load(); err == nil {
		t.Fatal("HTTP base URL was accepted in release mode")
	}
}
