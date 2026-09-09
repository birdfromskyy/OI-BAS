package httpapi

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

func hasRole(u user, wanted string) bool {
	for _, role := range u.Roles {
		role = strings.TrimSpace(strings.ToLower(role))
		// Владелец компании — высшая роль и имеет все административные полномочия.
		if role == wanted || (wanted == "администратор" && role == "владелец") {
			return true
		}
	}
	return false
}

var knownRoles = map[string]bool{"владелец": true, "администратор": true, "пилот": true, "наблюдатель": true}

func decodeRoles(raw string) []string {
	roles := []string{}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		role := strings.ToLower(strings.TrimSpace(part))
		if knownRoles[role] && !seen[role] {
			roles, seen[role] = append(roles, role), true
		}
	}
	return roles
}

func encodeRoles(roles []string) (string, error) {
	clean := []string{}
	seen := map[string]bool{}
	for _, role := range roles {
		role = strings.ToLower(strings.TrimSpace(role))
		if !knownRoles[role] {
			return "", fmt.Errorf("unknown role: %s", role)
		}
		if !seen[role] {
			clean, seen[role] = append(clean, role), true
		}
	}
	return strings.Join(clean, ", "), nil
}

// allowedRoles is the server-side counterpart of roles.ts. The browser may
// hide unavailable choices, but it is never trusted to enforce that policy.
func (s *server) allowedRoles(actor user, wanted []string, targetID string) (string, error) {
	encoded, err := encodeRoles(wanted)
	if err != nil {
		return "", err
	}
	if !hasRole(actor, "администратор") {
		return "", errors.New("administrator role is required")
	}
	if targetID == "" {
		if !hasRole(actor, "владелец") {
			for _, role := range decodeRoles(encoded) {
				if role == "администратор" {
					return "", errors.New("only owner may assign administrator role")
				}
			}
		}
		if strings.Contains(encoded, "владелец") {
			return "", errors.New("owner role is transferred, not assigned")
		}
		return encoded, nil
	}
	var previous string
	if err := s.db.QueryRow(context.Background(), "SELECT roles FROM users WHERE id=$1", targetID).Scan(&previous); err != nil {
		return "", errors.New("user not found")
	}
	old := decodeRoles(previous)
	if contains(old, "владелец") {
		return "", errors.New("owner role is transferred by a separate operation")
	}
	if !hasRole(actor, "владелец") {
		for _, role := range old {
			if role == "администратор" && !contains(decodeRoles(encoded), role) {
				return "", errors.New("only owner may change administrator role")
			}
		}
		for _, role := range decodeRoles(encoded) {
			if role == "администратор" && !contains(old, role) {
				return "", errors.New("only owner may assign administrator role")
			}
		}
	}
	if strings.Contains(encoded, "владелец") {
		return "", errors.New("owner role is transferred, not assigned")
	}
	return encoded, nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
