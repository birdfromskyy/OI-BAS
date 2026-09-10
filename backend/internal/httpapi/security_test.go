package httpapi

import (
	"testing"
	"time"
)

func TestRateLimiterRefillsAndRejectsBurst(t *testing.T) {
	limiter := newRateLimiter(2, 1)
	now := time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC)
	if !limiter.allow("client", now) || !limiter.allow("client", now) {
		t.Fatal("initial capacity was not available")
	}
	if limiter.allow("client", now) {
		t.Fatal("bucket accepted a request above capacity")
	}
	if !limiter.allow("client", now.Add(time.Second)) {
		t.Fatal("bucket did not refill")
	}
}
