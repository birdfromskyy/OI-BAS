package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const maxRequestBodyBytes int64 = 2 << 20

// rateLimiter is an in-memory token bucket. It deliberately limits only
// access-link guesses and abnormally noisy authenticated clients; normal PWA
// synchronization batches are not throttled.
type rateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	capacity float64
	refill   float64
}

type bucket struct {
	tokens   float64
	updated  time.Time
	lastSeen time.Time
}

func newRateLimiter(capacity, refillPerSecond float64) *rateLimiter {
	return &rateLimiter{buckets: make(map[string]*bucket), capacity: capacity, refill: refillPerSecond}
}

func (l *rateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.buckets) > 4096 {
		for candidate, item := range l.buckets {
			if now.Sub(item.lastSeen) > time.Hour {
				delete(l.buckets, candidate)
			}
		}
	}
	item := l.buckets[key]
	if item == nil {
		item = &bucket{tokens: l.capacity, updated: now}
		l.buckets[key] = item
	}
	elapsed := now.Sub(item.updated).Seconds()
	item.tokens = min(l.capacity, item.tokens+elapsed*l.refill)
	item.updated = now
	item.lastSeen = now
	if item.tokens < 1 {
		return false
	}
	item.tokens--
	return true
}

func (s *server) getLimiter() *rateLimiter {
	s.limiterOnce.Do(func() {
		s.limiter = newRateLimiter(300, 5)
	})
	return s.limiter
}

// This separate limiter keeps an invalid token from consuming the normal
// per-user request budget and makes brute force impractical.
var accessLimiter = newRateLimiter(20, 0.25)

func (s *server) requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := make([]byte, 12)
		if _, err := rand.Read(requestID); err == nil {
			c.Header("X-Request-ID", hex.EncodeToString(requestID))
		}
		c.Next()
	}
}

func (s *server) limitRequestBody() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > maxRequestBodyBytes {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body is too large"})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRequestBodyBytes)
		c.Next()
	}
}

func (s *server) limitByUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !s.getLimiter().allow("user:"+current(c).ID, time.Now()) {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many requests"})
			return
		}
		c.Next()
	}
}

func requestClient(c *gin.Context) string {
	// The API has no published host port. Caddy is the only external entry
	// point and supplies a single IP value, therefore an untrusted XFF chain is
	// neither accepted nor logged by the application.
	if ip := net.ParseIP(strings.TrimSpace(c.GetHeader("X-Real-IP"))); ip != nil {
		return ip.String()
	}
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return c.Request.RemoteAddr
}

func rejectInvalidAccess(c *gin.Context, message string) {
	if !accessLimiter.allow("access:"+requestClient(c), time.Now()) {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many access attempts"})
		return
	}
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": message})
}

func invalidJSONStatus(err error) int {
	var maxBytes *http.MaxBytesError
	if errors.As(err, &maxBytes) {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}
