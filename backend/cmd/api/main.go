// Command api starts OI-BAS and provides the one-time bootstrap command.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"ekipazh/internal/config"
	"ekipazh/internal/database/postgres"
	"ekipazh/internal/httpapi"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := postgres.Open(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConns)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	api := httpapi.New(pool, cfg.BaseURL)
	if err := api.Migrate(ctx); err != nil {
		log.Fatal(fmt.Errorf("migrate database: %w", err))
	}
	if len(os.Args) > 1 && os.Args[1] == "bootstrap" {
		link, err := api.Bootstrap(ctx, strings.Join(os.Args[2:], " "))
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("Администратор создан. Сохраните ссылку: %s\n", link)
		return
	}

	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           api.Router(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("API listening on :%s", cfg.Port)
		errCh <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown: %v", err)
		}
	}
}
