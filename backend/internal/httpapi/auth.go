package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
)

func scanUser(row pgx.Row) (user, error) {
	var u user
	var roles string
	err := row.Scan(&u.ID, &u.Name, &u.Position, &roles, &u.Phone, &u.Hours, &u.Flights, &u.Status)
	u.Roles = decodeRoles(roles)
	return u, err
}

func (s *server) accessURL(t string) string { return s.cfg.baseURL + "/?access=" + t }

// Bootstrap creates the only initial account. Subsequent accounts must be
// created by a user with administrative rights through the API.
func (s *server) Bootstrap(ctx context.Context, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Администратор"
	}
	var count int
	if err := s.db.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
		return "", err
	}
	if count > 0 {
		return "", errors.New("bootstrap is allowed only for an empty database")
	}
	raw := token()
	u := user{ID: newID(), Name: name, Roles: []string{"владелец", "администратор"}, Status: "активен"}
	_, err := s.db.Exec(ctx, "INSERT INTO users(id,name,roles,status,access_hash) VALUES($1,$2,$3,$4,$5)", u.ID, u.Name, "владелец, администратор", u.Status, tokenHash(raw))
	if err != nil {
		return "", err
	}
	return s.accessURL(raw), nil
}

func (s *server) requireUser(c *gin.Context) {
	h := strings.TrimSpace(c.GetHeader("Authorization"))
	const p = "Bearer "
	if !strings.HasPrefix(h, p) {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "access link is required"})
		return
	}
	// A personal link doubles as invitation acceptance. Its first valid use
	// activates the account atomically; revoked and deactivated accounts are
	// intentionally excluded from this transition.
	u, err := scanUser(s.db.QueryRow(c, "UPDATE users SET status='активен',updated_at=now() WHERE access_hash=$1 AND access_revoked_at IS NULL AND status IN ('активен','приглашён') RETURNING id,name,position,roles,phone,flight_hours,flight_count,status", tokenHash(strings.TrimPrefix(h, p))))
	if errors.Is(err, pgx.ErrNoRows) {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "access link is invalid or revoked"})
		return
	}
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.Set("user", u)
	c.Next()
}

func current(c *gin.Context) user { return c.MustGet("user").(user) }

func admin(c *gin.Context) bool {
	if !hasRole(current(c), "администратор") {
		c.JSON(http.StatusForbidden, gin.H{"error": "administrator role is required"})
		return false
	}
	return true
}
