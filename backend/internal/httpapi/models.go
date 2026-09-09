package httpapi

import "encoding/json"

// user is the API representation of a staff member. Access hashes are
// deliberately absent: the database is the only place where their digest is
// handled.
type user struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Position string   `json:"position"`
	Roles    []string `json:"roles"`
	Phone    string   `json:"phone"`
	Hours    float64  `json:"hours"`
	Flights  int      `json:"flights"`
	Status   string   `json:"status"`
}

type sessionUser struct {
	user
	Company  string `json:"company"`
	Timezone string `json:"timezone"`
}

// operation is a single idempotent offline-sync mutation.
type operation struct {
	ID     string          `json:"id"`
	Entity string          `json:"entity"`
	Action string          `json:"action"`
	Data   json.RawMessage `json:"data"`
}
