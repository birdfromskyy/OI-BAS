// Package httpapi owns the HTTP transport and access-link authentication for
// OI-BAS. Business rules intentionally remain behind the API boundary so the
// Svelte PWA is able to use the same contract online and during sync.
package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct{ baseURL string }

// Server is the application HTTP server. It does not own the database pool;
// the composition root closes the pool during graceful shutdown.
type Server struct {
	db          *pgxpool.Pool
	cfg         config
	limiterOnce sync.Once
	limiter     *rateLimiter
}

// server is kept as an internal alias while the handlers use concise
// receivers. It makes the public Server type available without disrupting
// handler code or its tests.
type server = Server

const schema = `
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, name text NOT NULL, position text NOT NULL DEFAULT '', roles text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', flight_hours numeric(10,2) NOT NULL DEFAULT 0, flight_count integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'активен', access_hash bytea UNIQUE, access_revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aircraft (id uuid PRIMARY KEY, data jsonb NOT NULL, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS checklists (id uuid PRIMARY KEY, data jsonb NOT NULL, version integer NOT NULL DEFAULT 1, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS checklist_versions (checklist_id uuid NOT NULL REFERENCES checklists(id), version integer NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(checklist_id, version));
CREATE TABLE IF NOT EXISTS flights (id uuid PRIMARY KEY, data jsonb NOT NULL, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sites (id uuid PRIMARY KEY, data jsonb NOT NULL, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS batteries (id uuid PRIMARY KEY, data jsonb NOT NULL, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS runs (id uuid PRIMARY KEY, flight_id uuid NOT NULL, data jsonb NOT NULL, signed_at timestamptz, voided_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY, actor_id uuid REFERENCES users(id), entity text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sync_operations (id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), entity text, record_id uuid, revision integer, applied_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE users ADD COLUMN IF NOT EXISTS flight_hours numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS flight_count integer NOT NULL DEFAULT 0;
ALTER TABLE sync_operations ADD COLUMN IF NOT EXISTS entity text;
ALTER TABLE sync_operations ADD COLUMN IF NOT EXISTS record_id uuid;
ALTER TABLE sync_operations ADD COLUMN IF NOT EXISTS revision integer;
`

// hybridSchema keeps the original JSON documents intact while promoting every
// field used for relations, permissions, filtering or reporting to a proper
// PostgreSQL column.  Existing installations are migrated in place: no row or
// historical JSON snapshot is deleted.
const hybridSchema = `
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '';
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS reg text NOT NULL DEFAULT '';
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'годен';
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS flight_hours numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS flight_count integer NOT NULL DEFAULT 0;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS service_interval numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS serviced_hours numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE aircraft ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS latitude numeric(10,7) NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS longitude numeric(10,7) NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE batteries ADD COLUMN IF NOT EXISTS serial text NOT NULL DEFAULT '';
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'в строю';
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS started_on date;
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS checked_on date;
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS checked_time time;
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS capacity numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS capacity_now numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS output numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS output_now numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS note text NOT NULL DEFAULT '';
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE checklists ADD COLUMN IF NOT EXISTS aircraft_id uuid;
ALTER TABLE checklists ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '';
ALTER TABLE checklists ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE checklists ADD COLUMN IF NOT EXISTS author_name text NOT NULL DEFAULT '';
ALTER TABLE checklists ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE flights ADD COLUMN IF NOT EXISTS aircraft_id uuid;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS pilot_id uuid;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS checklist_id uuid;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS site_id uuid;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'черновик';
ALTER TABLE flights ADD COLUMN IF NOT EXISTS flight_date date;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS takeoff_at time;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS landing_at time;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS duration_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS altitude numeric(10,2) NOT NULL DEFAULT 0;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS task text NOT NULL DEFAULT '';
ALTER TABLE flights ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE runs ADD COLUMN IF NOT EXISTS checklist_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS pilot_id uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS run_date date;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

UPDATE aircraft SET
 model=COALESCE(NULLIF(data->>'model',''), model),
 reg=COALESCE(data->>'reg', reg),
 status=COALESCE(NULLIF(data->>'status',''), status),
 flight_hours=CASE WHEN COALESCE(data->>'hours','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'hours')::numeric ELSE flight_hours END,
 flight_count=CASE WHEN COALESCE(data->>'flights','') ~ '^-?[0-9]+$' THEN (data->>'flights')::integer ELSE flight_count END,
 service_interval=CASE WHEN COALESCE(data->>'service','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'service')::numeric ELSE service_interval END,
 serviced_hours=CASE WHEN COALESCE(data->>'serviced','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'serviced')::numeric ELSE serviced_hours END;

UPDATE sites SET
 name=COALESCE(NULLIF(data->>'name',''), name),
 latitude=CASE WHEN COALESCE(data->>'lat','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'lat')::numeric ELSE latitude END,
 longitude=CASE WHEN COALESCE(data->>'lon','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'lon')::numeric ELSE longitude END,
 note=COALESCE(data->>'note', note);

UPDATE batteries SET
 serial=COALESCE(NULLIF(data->>'serial',''), serial),
 status=COALESCE(NULLIF(data->>'status',''), status),
 started_on=CASE WHEN COALESCE(data->>'started','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (data->>'started')::date ELSE started_on END,
 checked_on=CASE WHEN COALESCE(data->>'checked','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (data->>'checked')::date ELSE checked_on END,
 checked_time=CASE WHEN COALESCE(data->>'checkedAt','') ~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$' THEN (data->>'checkedAt')::time ELSE checked_time END,
 capacity=CASE WHEN COALESCE(data->>'capacity','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'capacity')::numeric ELSE capacity END,
 capacity_now=CASE WHEN COALESCE(data->>'capacityNow','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'capacityNow')::numeric ELSE capacity_now END,
 output=CASE WHEN COALESCE(data->>'output','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'output')::numeric ELSE output END,
 output_now=CASE WHEN COALESCE(data->>'outputNow','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'outputNow')::numeric ELSE output_now END,
 note=COALESCE(data->>'note', note);

UPDATE checklists SET
 aircraft_id=CASE WHEN COALESCE(data->>'aircraftId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (data->>'aircraftId')::uuid ELSE aircraft_id END,
 model=COALESCE(data->>'model', model),
 title=COALESCE(data->>'title', title),
 author_name=COALESCE(data->>'author', author_name),
 version=CASE WHEN COALESCE(data->>'version','') ~ '^[0-9]+$' THEN (data->>'version')::integer ELSE version END;

UPDATE flights SET
 aircraft_id=CASE WHEN COALESCE(data->>'aircraftId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (data->>'aircraftId')::uuid ELSE aircraft_id END,
 pilot_id=CASE WHEN COALESCE(data->>'pilotId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (data->>'pilotId')::uuid ELSE pilot_id END,
 status=COALESCE(NULLIF(data->>'status',''), status),
 flight_date=CASE WHEN COALESCE(data->>'date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (data->>'date')::date ELSE flight_date END,
 takeoff_at=CASE WHEN COALESCE(data->>'takeoff','') ~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$' THEN (data->>'takeoff')::time ELSE takeoff_at END,
 landing_at=CASE WHEN COALESCE(data->>'landing','') ~ '^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$' THEN (data->>'landing')::time ELSE landing_at END,
 duration_seconds=CASE WHEN COALESCE(data->>'duration','') ~ '^-?[0-9]+$' THEN (data->>'duration')::integer ELSE duration_seconds END,
 altitude=CASE WHEN COALESCE(data->>'alt','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (data->>'alt')::numeric ELSE altitude END,
 task=COALESCE(data->>'task', task);

UPDATE flights f SET checklist_id=(SELECT c.id FROM checklists c WHERE c.deleted_at IS NULL AND c.aircraft_id=f.aircraft_id AND c.title=f.data->>'checklist' ORDER BY c.updated_at DESC LIMIT 1)
WHERE f.checklist_id IS NULL AND f.aircraft_id IS NOT NULL AND COALESCE(f.data->>'checklist','') <> '';
UPDATE flights f SET site_id=(SELECT s.id FROM sites s WHERE s.deleted_at IS NULL AND s.name=f.data->>'site' ORDER BY s.updated_at DESC LIMIT 1)
WHERE f.site_id IS NULL AND COALESCE(f.data->>'site','') <> '';

UPDATE runs r SET
 checklist_id=CASE WHEN COALESCE(r.data->>'checklistId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (r.data->>'checklistId')::uuid ELSE checklist_id END,
 run_date=CASE WHEN COALESCE(r.data->>'date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (r.data->>'date')::date ELSE run_date END;
UPDATE runs r SET pilot_id=f.pilot_id FROM flights f WHERE r.flight_id=f.id AND r.pilot_id IS NULL;

UPDATE aircraft SET data=data || jsonb_build_object('id', id, 'revision', revision);
UPDATE sites SET data=data || jsonb_build_object('id', id, 'revision', revision);
UPDATE batteries SET data=data || jsonb_build_object('id', id, 'revision', revision);
UPDATE checklists SET data=data || jsonb_build_object('id', id, 'revision', revision);
UPDATE flights SET data=data || jsonb_build_object('id', id, 'revision', revision, 'checklistId', checklist_id, 'siteId', site_id);
UPDATE runs SET data=data || jsonb_build_object('id', id, 'revision', revision, 'pilotId', pilot_id);

CREATE INDEX IF NOT EXISTS aircraft_active_idx ON aircraft(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS checklists_aircraft_active_idx ON checklists(aircraft_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS flights_active_idx ON flights(status, flight_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS flights_aircraft_active_idx ON flights(aircraft_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS flights_pilot_active_idx ON flights(pilot_id) WHERE deleted_at IS NULL;

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='checklists_aircraft_fk') THEN
  ALTER TABLE checklists ADD CONSTRAINT checklists_aircraft_fk FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='flights_aircraft_fk') THEN
  ALTER TABLE flights ADD CONSTRAINT flights_aircraft_fk FOREIGN KEY (aircraft_id) REFERENCES aircraft(id) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='flights_pilot_fk') THEN
  ALTER TABLE flights ADD CONSTRAINT flights_pilot_fk FOREIGN KEY (pilot_id) REFERENCES users(id) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='flights_checklist_fk') THEN
  ALTER TABLE flights ADD CONSTRAINT flights_checklist_fk FOREIGN KEY (checklist_id) REFERENCES checklists(id) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='flights_site_fk') THEN
  ALTER TABLE flights ADD CONSTRAINT flights_site_fk FOREIGN KEY (site_id) REFERENCES sites(id) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='runs_checklist_fk') THEN
  ALTER TABLE runs ADD CONSTRAINT runs_checklist_fk FOREIGN KEY (checklist_id) REFERENCES checklists(id) NOT VALID;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='runs_pilot_fk') THEN
  ALTER TABLE runs ADD CONSTRAINT runs_pilot_fk FOREIGN KEY (pilot_id) REFERENCES users(id) NOT VALID;
 END IF;
END $$;
`

// New constructs the API server. baseURL is used only to create personal
// access links; it is never trusted as an incoming request value.
func New(db *pgxpool.Pool, baseURL string) *Server {
	return &Server{db: db, cfg: config{baseURL: strings.TrimRight(baseURL, "/")}}
}

// Router returns the complete HTTP contract served by the API.
func (s *server) Router() *gin.Engine { return s.router() }

// Migrate applies backward-compatible schema updates. It never drops user
// data and may safely be called at every application start.
func (s *server) Migrate(ctx context.Context) error { return s.migrate(ctx) }

func (s *server) router() *gin.Engine {
	r := gin.New()
	// API is only proxied by the local web container. It does not use client IP
	// headers for authorization, so trusting every upstream proxy is needless
	// and would make the usual Gin warning a real production footgun.
	_ = r.SetTrustedProxies(nil)
	r.Use(s.requestID(), gin.Logger(), gin.Recovery())
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	r.GET("/readyz", s.ready)
	api := r.Group("/api/v1")
	api.Use(s.limitRequestBody(), s.requireUser, s.limitByUser())
	api.GET("/bootstrap", s.getBootstrap)
	api.POST("/sync", s.sync)
	api.PUT("/me", s.updateMe)
	api.POST("/users", s.createUser)
	api.PUT("/users/:id", s.updateUser)
	api.POST("/users/:id/access-link", s.regenerateLink)
	api.DELETE("/users/:id/access-link", s.revokeLink)
	api.POST("/users/:id/transfer-ownership", s.transferOwnership)
	return r
}

func (s *server) ready(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (s *server) migrate(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, schema); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, hybridSchema)
	return err
}
func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func token() string               { b := make([]byte, 32); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func tokenHash(raw string) []byte { sum := sha256.Sum256([]byte(raw)); return sum[:] }
func isUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	_, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	return err == nil
}

func (s *server) getBootstrap(c *gin.Context) {
	u := current(c)
	out := gin.H{"profile": sessionUser{user: u, Company: "Экипаж", Timezone: "Asia/Yekaterinburg"}}
	var users []user
	rows, err := s.db.Query(c, "SELECT id,name,position,roles,phone,flight_hours,flight_count,status FROM users ORDER BY created_at")
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	defer rows.Close()
	for rows.Next() {
		var x user
		var roles string
		if err := rows.Scan(&x.ID, &x.Name, &x.Position, &roles, &x.Phone, &x.Hours, &x.Flights, &x.Status); err == nil {
			x.Roles = decodeRoles(roles)
			users = append(users, x)
		}
	}
	out["users"] = users
	for _, table := range []string{"aircraft", "checklists", "flights", "runs", "sites", "batteries"} {
		data, err := s.rowsJSON(c, table)
		if err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		out[table] = data
	}
	c.JSON(200, out)
}
func (s *server) rowsJSON(ctx context.Context, table string) ([]json.RawMessage, error) {
	q := "SELECT data FROM " + table
	if table != "runs" {
		q += " WHERE deleted_at IS NULL"
	}
	q += " ORDER BY updated_at"
	rows, err := s.db.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *server) sync(c *gin.Context) {
	var in struct {
		Operations []operation `json:"operations"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(invalidJSONStatus(err), gin.H{"error": "invalid JSON"})
		return
	}
	u := current(c)
	tx, err := s.db.Begin(c)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	defer tx.Rollback(c)
	acked := []string{}
	type applied struct {
		OperationID string `json:"operationId"`
		Entity      string `json:"entity"`
		RecordID    string `json:"recordId"`
		Revision    int    `json:"revision"`
	}
	appliedRecords := []applied{}
	for _, op := range in.Operations {
		if !isUUID(op.ID) {
			c.JSON(400, gin.H{"error": "operation id must be UUID", "operation": op.ID})
			return
		}
		seen, err := tx.Exec(c, "INSERT INTO sync_operations(id,actor_id) VALUES($1,$2) ON CONFLICT DO NOTHING", op.ID, u.ID)
		if err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
		if seen.RowsAffected() == 0 {
			acked = append(acked, op.ID)
			// The request may have reached PostgreSQL but its HTTP response been
			// lost with the network. Return the original revision again, otherwise
			// the client would keep an old revision and its next offline edit would
			// falsely conflict.
			var entity string
			var recordID *string
			var revision *int
			if err = tx.QueryRow(c, "SELECT entity,record_id::text,revision FROM sync_operations WHERE id=$1", op.ID).Scan(&entity, &recordID, &revision); err != nil {
				c.JSON(500, gin.H{"error": "database error"})
				return
			}
			if recordID != nil && revision != nil {
				appliedRecords = append(appliedRecords, applied{OperationID: op.ID, Entity: entity, RecordID: *recordID, Revision: *revision})
			}
			continue
		}
		revision, err := s.apply(c, tx, u, op)
		if err != nil {
			c.JSON(409, gin.H{"error": err.Error(), "operation": op.ID})
			return
		}
		acked = append(acked, op.ID)
		var meta struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(op.Data, &meta)
		appliedRecords = append(appliedRecords, applied{OperationID: op.ID, Entity: op.Entity, RecordID: meta.ID, Revision: revision})
		if _, err = tx.Exec(c, "UPDATE sync_operations SET entity=$2,record_id=$3,revision=$4 WHERE id=$1", op.ID, op.Entity, meta.ID, revision); err != nil {
			c.JSON(500, gin.H{"error": "database error"})
			return
		}
	}
	if err := tx.Commit(c); err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.JSON(200, gin.H{"acked": acked, "applied": appliedRecords})
}

func document(raw json.RawMessage) (map[string]any, string, int, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		return nil, "", 0, errors.New("entity data must be an object")
	}
	id, _ := value["id"].(string)
	if !isUUID(id) {
		return nil, "", 0, errors.New("client ids must be UUIDs")
	}
	return value, id, intValue(value["revision"]), nil
}

func textValue(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func intValue(value any) int {
	switch value := value.(type) {
	case json.Number:
		n, _ := strconv.Atoi(value.String())
		return n
	case float64:
		return int(value)
	case float32:
		return int(value)
	case int:
		return value
	case int64:
		return int(value)
	case string:
		n, _ := strconv.Atoi(value)
		return n
	default:
		return 0
	}
}

func docID(doc map[string]any, key string, required bool) (string, error) {
	id := textValue(doc[key])
	if id == "" && !required {
		return "", nil
	}
	if !isUUID(id) {
		return "", fmt.Errorf("%s must be UUID", key)
	}
	return id, nil
}

func encodeDocument(doc map[string]any, id string, revision int) (json.RawMessage, error) {
	doc["id"] = id
	doc["revision"] = revision
	encoded, err := json.Marshal(doc)
	return json.RawMessage(encoded), err
}

func tableFor(entity string) string {
	return map[string]string{
		"aircraft": "aircraft", "battery": "batteries", "checklist": "checklists",
		"flight": "flights", "site": "sites", "run": "runs",
	}[entity]
}

func isOneOf(value string, allowed ...string) bool {
	for _, option := range allowed {
		if value == option {
			return true
		}
	}
	return false
}

func timeValue(value string, layout string) error {
	if value == "" {
		return nil
	}
	if _, err := time.Parse(layout, value); err != nil {
		return errors.New("invalid date or time")
	}
	return nil
}

// numericFields makes projection into the typed PostgreSQL columns safe. JSON
// is intentionally retained for extensible UI fields, but malformed numeric
// values must not turn a client request into a database cast error.
func numericFields(doc map[string]any, fields ...string) error {
	for _, field := range fields {
		value, present := doc[field]
		if !present || value == nil {
			continue
		}
		if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
			continue
		}
		var raw string
		switch value := value.(type) {
		case json.Number:
			raw = value.String()
		case float64:
			raw = strconv.FormatFloat(value, 'f', -1, 64)
		case float32:
			raw = strconv.FormatFloat(float64(value), 'f', -1, 32)
		case int, int64:
			raw = fmt.Sprint(value)
		case string:
			raw = strings.TrimSpace(value)
		default:
			return fmt.Errorf("%s must be a number", field)
		}
		if _, err := strconv.ParseFloat(raw, 64); err != nil {
			return fmt.Errorf("%s must be a number", field)
		}
	}
	return nil
}

func (s *server) activeReference(ctx context.Context, tx pgx.Tx, table, id, label string) error {
	if id == "" {
		return nil
	}
	var found bool
	err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM "+table+" WHERE id=$1 AND deleted_at IS NULL)", id).Scan(&found)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%s not found or deleted", label)
	}
	return nil
}

func (s *server) activeUser(ctx context.Context, tx pgx.Tx, id string) error {
	var status string
	if err := tx.QueryRow(ctx, "SELECT status FROM users WHERE id=$1", id).Scan(&status); err != nil {
		return errors.New("pilot not found")
	}
	// План можно оформить на приглашённого пилота: ссылка ещё не была открыта,
	// но он уже сотрудник команды. Деактивированному назначение запрещено.
	if status != "активен" && status != "приглашён" {
		return errors.New("pilot is not active or invited")
	}
	return nil
}

var businessTimezone = time.FixedZone("Asia/Yekaterinburg", 5*60*60)

func businessToday() time.Time {
	now := time.Now().In(businessTimezone)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, businessTimezone)
}

// upsertDocument applies optimistic locking. A new client-generated UUID has
// revision zero; every update must bring the revision received from bootstrap.
func (s *server) upsertDocument(ctx context.Context, tx pgx.Tx, entity, id string, base int, doc map[string]any) (int, json.RawMessage, error) {
	table := tableFor(entity)
	if table == "" {
		return 0, nil, errors.New("unknown entity")
	}
	if base <= 0 {
		data, err := encodeDocument(doc, id, 1)
		if err != nil {
			return 0, nil, err
		}
		var revision int
		if entity == "run" {
			flightID, err := docID(doc, "flightId", true)
			if err != nil {
				return 0, nil, err
			}
			err = tx.QueryRow(ctx, "INSERT INTO runs(id,flight_id,data,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING revision", id, flightID, data, 1).Scan(&revision)
		} else {
			err = tx.QueryRow(ctx, "INSERT INTO "+table+"(id,data,revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING revision", id, data, 1).Scan(&revision)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil, errors.New("record already exists or was deleted; reload data")
		}
		if err != nil {
			return 0, nil, err
		}
		return revision, data, nil
	}
	next := base + 1
	data, err := encodeDocument(doc, id, next)
	if err != nil {
		return 0, nil, err
	}
	var revision int
	if entity == "run" {
		err = tx.QueryRow(ctx, "UPDATE runs SET data=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 AND signed_at IS NULL RETURNING revision", id, base, data).Scan(&revision)
	} else {
		err = tx.QueryRow(ctx, "UPDATE "+table+" SET data=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 AND deleted_at IS NULL RETURNING revision", id, base, data).Scan(&revision)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, errors.New("record changed or deleted on another device")
	}
	if err != nil {
		return 0, nil, err
	}
	return revision, data, nil
}

func (s *server) projectDocument(ctx context.Context, tx pgx.Tx, entity, id string, data json.RawMessage) error {
	const json = "$2::jsonb"
	queries := map[string]string{
		"aircraft":  "UPDATE aircraft SET model=COALESCE(NULLIF(" + json + "->>'model',''),''),reg=COALESCE(" + json + "->>'reg',''),status=COALESCE(NULLIF(" + json + "->>'status',''),'годен'),flight_hours=COALESCE(NULLIF(" + json + "->>'hours','')::numeric,0),flight_count=COALESCE(NULLIF(" + json + "->>'flights','')::integer,0),service_interval=COALESCE(NULLIF(" + json + "->>'service','')::numeric,0),serviced_hours=COALESCE(NULLIF(" + json + "->>'serviced','')::numeric,0) WHERE id=$1",
		"site":      "UPDATE sites SET name=COALESCE(NULLIF(" + json + "->>'name',''),''),latitude=COALESCE(NULLIF(" + json + "->>'lat','')::numeric,0),longitude=COALESCE(NULLIF(" + json + "->>'lon','')::numeric,0),note=COALESCE(" + json + "->>'note','') WHERE id=$1",
		"battery":   "UPDATE batteries SET serial=COALESCE(NULLIF(" + json + "->>'serial',''),''),status=COALESCE(NULLIF(" + json + "->>'status',''),'в строю'),started_on=NULLIF(" + json + "->>'started','')::date,checked_on=NULLIF(" + json + "->>'checked','')::date,checked_time=NULLIF(" + json + "->>'checkedAt','')::time,capacity=COALESCE(NULLIF(" + json + "->>'capacity','')::numeric,0),capacity_now=COALESCE(NULLIF(" + json + "->>'capacityNow','')::numeric,0),output=COALESCE(NULLIF(" + json + "->>'output','')::numeric,0),output_now=COALESCE(NULLIF(" + json + "->>'outputNow','')::numeric,0),note=COALESCE(" + json + "->>'note','') WHERE id=$1",
		"checklist": "UPDATE checklists SET aircraft_id=NULLIF(" + json + "->>'aircraftId','')::uuid,model=COALESCE(" + json + "->>'model',''),title=COALESCE(NULLIF(" + json + "->>'title',''),''),author_name=COALESCE(" + json + "->>'author',''),version=COALESCE(NULLIF(" + json + "->>'version','')::integer,1) WHERE id=$1",
		"flight":    "UPDATE flights SET aircraft_id=NULLIF(" + json + "->>'aircraftId','')::uuid,pilot_id=NULLIF(" + json + "->>'pilotId','')::uuid,checklist_id=NULLIF(" + json + "->>'checklistId','')::uuid,site_id=NULLIF(" + json + "->>'siteId','')::uuid,status=COALESCE(NULLIF(" + json + "->>'status',''),'черновик'),flight_date=NULLIF(" + json + "->>'date','')::date,takeoff_at=NULLIF(" + json + "->>'takeoff','')::time,landing_at=NULLIF(" + json + "->>'landing','')::time,duration_seconds=COALESCE(NULLIF(" + json + "->>'duration','')::integer,0),altitude=COALESCE(NULLIF(" + json + "->>'alt','')::numeric,0),task=COALESCE(" + json + "->>'task','') WHERE id=$1",
		"run":       "UPDATE runs SET checklist_id=NULLIF(" + json + "->>'checklistId','')::uuid,pilot_id=NULLIF(" + json + "->>'pilotId','')::uuid,run_date=NULLIF(" + json + "->>'date','')::date,signed_at=CASE WHEN COALESCE(" + json + "->>'signature','') <> '' THEN now() ELSE signed_at END,voided_at=CASE WHEN COALESCE(" + json + "->>'voided','') <> '' THEN now() ELSE voided_at END WHERE id=$1",
	}
	_, err := tx.Exec(ctx, queries[entity], id, string(data))
	return err
}

func (s *server) validateChecklist(ctx context.Context, tx pgx.Tx, id string, doc map[string]any) error {
	if textValue(doc["title"]) == "" || intValue(doc["version"]) < 1 {
		return errors.New("checklist title and version are required")
	}
	aircraftID, err := docID(doc, "aircraftId", false)
	if err != nil {
		return err
	}
	if aircraftID == "" {
		return nil // model template
	}
	if err = s.activeReference(ctx, tx, "aircraft", aircraftID, "aircraft"); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM checklists WHERE id=$1 AND deleted_at IS NULL)", id).Scan(&exists); err != nil {
		return err
	}
	if exists {
		var currentVersion int
		if err = tx.QueryRow(ctx, "SELECT version FROM checklists WHERE id=$1", id).Scan(&currentVersion); err != nil {
			return err
		}
		if intValue(doc["version"]) <= currentVersion {
			return errors.New("checklist has a newer or equal version; reload data")
		}
	}
	if !exists {
		// Locking the parent serializes concurrent offline creations, so the
		// three-checklist limit is enforced by the server as well as the UI.
		if _, err = tx.Exec(ctx, "SELECT id FROM aircraft WHERE id=$1 FOR UPDATE", aircraftID); err != nil {
			return err
		}
		var count int
		if err = tx.QueryRow(ctx, "SELECT count(*) FROM checklists WHERE aircraft_id=$1 AND deleted_at IS NULL", aircraftID).Scan(&count); err != nil {
			return err
		}
		if count >= 3 {
			return errors.New("an aircraft may have no more than three active checklists")
		}
	}
	return nil
}

func (s *server) validateFlight(ctx context.Context, tx pgx.Tx, doc map[string]any) error {
	status := textValue(doc["status"])
	if !isOneOf(status, "черновик", "запланирован", "подготовка пройдена", "выполняется", "завершён", "отменён") {
		return errors.New("unknown flight status")
	}
	dateText := textValue(doc["date"])
	if err := timeValue(dateText, "2006-01-02"); err != nil {
		return err
	}
	// Планирование — действие о будущем. Исторические завершённые записи можно
	// вести в журнале, но «запланирован» задним числом создавать нельзя.
	if status == "запланирован" {
		date, _ := time.ParseInLocation("2006-01-02", dateText, businessTimezone)
		if date.Before(businessToday()) {
			return errors.New("scheduled flight date cannot be in the past")
		}
	}
	if err := timeValue(textValue(doc["takeoff"]), "15:04:05"); err != nil && timeValue(textValue(doc["takeoff"]), "15:04") != nil {
		return err
	}
	if err := timeValue(textValue(doc["landing"]), "15:04:05"); err != nil && timeValue(textValue(doc["landing"]), "15:04") != nil {
		return err
	}
	aircraftID, err := docID(doc, "aircraftId", true)
	if err != nil {
		return err
	}
	if err = s.activeReference(ctx, tx, "aircraft", aircraftID, "aircraft"); err != nil {
		return err
	}
	pilotID, err := docID(doc, "pilotId", true)
	if err != nil {
		return err
	}
	if err = s.activeUser(ctx, tx, pilotID); err != nil {
		return err
	}
	checklistID, err := docID(doc, "checklistId", false)
	if err != nil {
		return err
	}
	if checklistID == "" && textValue(doc["checklist"]) != "" {
		err = tx.QueryRow(ctx, "SELECT id FROM checklists WHERE aircraft_id=$1 AND title=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1", aircraftID, textValue(doc["checklist"])).Scan(&checklistID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("checklist not found or deleted")
		}
		if err != nil {
			return err
		}
		doc["checklistId"] = checklistID
	}
	if checklistID != "" {
		var matches bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM checklists WHERE id=$1 AND aircraft_id=$2 AND deleted_at IS NULL)", checklistID, aircraftID).Scan(&matches); err != nil || !matches {
			return errors.New("checklist does not belong to the selected aircraft")
		}
	}
	siteID, err := docID(doc, "siteId", false)
	if err != nil {
		return err
	}
	if siteID == "" && textValue(doc["site"]) != "" {
		err = tx.QueryRow(ctx, "SELECT id FROM sites WHERE name=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1", textValue(doc["site"])).Scan(&siteID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("site not found or deleted")
		}
		if err != nil {
			return err
		}
		doc["siteId"] = siteID
	}
	if siteID != "" {
		if err = s.activeReference(ctx, tx, "sites", siteID, "site"); err != nil {
			return err
		}
	}
	return nil
}

func (s *server) authorizeFlight(ctx context.Context, tx pgx.Tx, actor user, id string, doc map[string]any, deleting bool) error {
	var currentStatus, assignedPilotID string
	err := tx.QueryRow(ctx, "SELECT status,COALESCE(pilot_id::text,'') FROM flights WHERE id=$1 AND deleted_at IS NULL", id).Scan(&currentStatus, &assignedPilotID)
	isNew := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !isNew {
		return err
	}
	if hasRole(actor, "администратор") {
		return nil
	}
	if !hasRole(actor, "пилот") {
		return errors.New("pilot or administrator role is required")
	}
	if isNew {
		if deleting || textValue(doc["status"]) != "запланирован" || textValue(doc["pilotId"]) != actor.ID {
			return errors.New("pilots create only their own scheduled flights")
		}
		return nil
	}
	if deleting {
		if currentStatus != "запланирован" {
			return errors.New("pilots may delete only scheduled flights")
		}
		return nil
	}
	nextStatus := textValue(doc["status"])
	if currentStatus == "запланирован" && nextStatus == "запланирован" {
		return nil
	}
	// These are state transitions performed by dedicated flight/checklist
	// actions, not a free edit of a completed record.
	// Подготовить борт может любой пилот команды. Но взлёт и посадку фиксирует
	// исключительно назначенный пилот: нельзя сменить pilotId в том же запросе
	// и забрать чужой полёт.
	if currentStatus == "запланирован" && nextStatus == "подготовка пройдена" {
		return nil
	}
	if (currentStatus == "подготовка пройдена" && nextStatus == "выполняется") ||
		(currentStatus == "выполняется" && nextStatus == "завершён") {
		if assignedPilotID == actor.ID && textValue(doc["pilotId"]) == assignedPilotID {
			return nil
		}
		return errors.New("only the assigned pilot may record takeoff or landing")
	}
	return errors.New("pilots may edit only scheduled flights")
}

func (s *server) validateRun(ctx context.Context, tx pgx.Tx, actor user, id string, doc map[string]any) error {
	flightID, err := docID(doc, "flightId", true)
	if err != nil {
		return err
	}
	if err = tx.QueryRow(ctx, "SELECT pilot_id FROM flights WHERE id=$1 AND deleted_at IS NULL", flightID).Scan(new(string)); err != nil {
		return errors.New("flight not found or deleted")
	}
	if !hasRole(actor, "администратор") && !hasRole(actor, "пилот") {
		return errors.New("pilot or administrator role is required")
	}
	// Подготовку вправе провести любой пилот, а в протоколе остаётся тот, кто
	// действительно её выполнял, а не назначенный на будущий взлёт коллега.
	doc["pilotId"] = actor.ID
	doc["pilot"] = actor.Name
	checklistID, err := docID(doc, "checklistId", true)
	if err != nil {
		return err
	}
	if err = s.activeReference(ctx, tx, "checklists", checklistID, "checklist"); err != nil {
		return err
	}
	var signed *time.Time
	if err = tx.QueryRow(ctx, "SELECT signed_at FROM runs WHERE id=$1", id).Scan(&signed); err == nil && signed != nil {
		return errors.New("signed run is immutable")
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return nil
}

func (s *server) softDelete(ctx context.Context, tx pgx.Tx, actor user, entity, id string, revision int) (int, error) {
	if revision < 1 {
		return 0, errors.New("record revision is required for deletion")
	}
	if entity == "run" {
		return 0, errors.New("runs cannot be deleted")
	}
	if entity == "flight" {
		if err := s.authorizeFlight(ctx, tx, actor, id, map[string]any{}, true); err != nil {
			return 0, err
		}
		var runs int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM runs WHERE flight_id=$1", id).Scan(&runs); err != nil {
			return 0, err
		}
		if runs > 0 {
			return 0, errors.New("flight has checklist runs and cannot be deleted")
		}
	}
	if entity == "aircraft" {
		// Пилот может создавать и править БВС в поле, но списание (даже
		// логическое) — административное действие. Проверка здесь обязательна:
		// скрытая кнопка интерфейса не защищает офлайн-запрос к API.
		if !hasRole(actor, "администратор") {
			return 0, errors.New("only administrator or owner may delete aircraft")
		}
		var flights, lists int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM flights WHERE aircraft_id=$1 AND deleted_at IS NULL", id).Scan(&flights); err != nil {
			return 0, err
		}
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM checklists WHERE aircraft_id=$1 AND deleted_at IS NULL", id).Scan(&lists); err != nil {
			return 0, err
		}
		if flights > 0 || lists > 0 {
			return 0, errors.New("aircraft has flights or checklists and cannot be deleted")
		}
	}
	if entity == "checklist" {
		var flights, runs int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM flights WHERE checklist_id=$1 AND deleted_at IS NULL", id).Scan(&flights); err != nil {
			return 0, err
		}
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM runs WHERE checklist_id=$1", id).Scan(&runs); err != nil {
			return 0, err
		}
		if flights > 0 || runs > 0 {
			return 0, errors.New("checklist is used by saved flights or runs and cannot be deleted")
		}
	}
	if entity == "site" {
		var flights int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM flights WHERE site_id=$1 AND deleted_at IS NULL", id).Scan(&flights); err != nil {
			return 0, err
		}
		if flights > 0 {
			return 0, errors.New("site is used by saved flights and cannot be deleted")
		}
	}
	table := tableFor(entity)
	var next int
	err := tx.QueryRow(ctx, "UPDATE "+table+" SET deleted_at=now(),revision=revision+1,data=jsonb_set(data,'{revision}',to_jsonb(revision+1),true),updated_at=now() WHERE id=$1 AND revision=$2 AND deleted_at IS NULL RETURNING revision", id, revision).Scan(&next)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, errors.New("record changed, deleted, or does not exist")
	}
	if err != nil {
		return 0, err
	}
	s.audit(ctx, tx, actor.ID, entity, id, "delete")
	return next, nil
}

func (s *server) apply(ctx context.Context, tx pgx.Tx, actor user, op operation) (int, error) {
	if op.ID == "" || op.Entity == "" || len(op.Data) == 0 {
		return 0, errors.New("operation fields are required")
	}
	doc, id, revision, err := document(op.Data)
	if err != nil {
		return 0, err
	}
	switch op.Entity {
	case "aircraft":
		if !hasRole(actor, "администратор") && !hasRole(actor, "пилот") {
			return 0, errors.New("pilot or administrator role is required")
		}
	case "battery":
		if !hasRole(actor, "администратор") && !hasRole(actor, "пилот") {
			return 0, errors.New("pilot or administrator role is required")
		}
	case "checklist":
		if !hasRole(actor, "администратор") && !hasRole(actor, "пилот") {
			return 0, errors.New("pilot or administrator role is required")
		}
	case "site":
		if !hasRole(actor, "администратор") && !hasRole(actor, "пилот") {
			return 0, errors.New("pilot or administrator role is required")
		}
	case "flight", "run":
	default:
		return 0, errors.New("unknown entity")
	}
	if op.Action == "delete" {
		return s.softDelete(ctx, tx, actor, op.Entity, id, revision)
	}
	if op.Action != "upsert" {
		return 0, errors.New("unknown action")
	}
	if op.Entity == "aircraft" && textValue(doc["model"]) == "" {
		return 0, errors.New("aircraft model is required")
	}
	if op.Entity == "aircraft" {
		if err := numericFields(doc, "hours", "flights", "service", "serviced"); err != nil {
			return 0, err
		}
	}
	if op.Entity == "battery" {
		if textValue(doc["serial"]) == "" || !isOneOf(textValue(doc["status"]), "в строю", "на хранении", "на проверке", "выведен") {
			return 0, errors.New("battery serial and status are required")
		}
		if err := timeValue(textValue(doc["started"]), "2006-01-02"); err != nil {
			return 0, err
		}
		if err := timeValue(textValue(doc["checked"]), "2006-01-02"); err != nil {
			return 0, err
		}
		if err := numericFields(doc, "capacity", "capacityNow", "output", "outputNow"); err != nil {
			return 0, err
		}
	}
	if op.Entity == "site" && textValue(doc["name"]) == "" {
		return 0, errors.New("site name is required")
	}
	if op.Entity == "site" {
		if err := numericFields(doc, "lat", "lon"); err != nil {
			return 0, err
		}
	}
	if op.Entity == "checklist" {
		if err := s.validateChecklist(ctx, tx, id, doc); err != nil {
			return 0, err
		}
	}
	if op.Entity == "flight" {
		if err := s.authorizeFlight(ctx, tx, actor, id, doc, false); err != nil {
			return 0, err
		}
		if err := s.validateFlight(ctx, tx, doc); err != nil {
			return 0, err
		}
		if err := numericFields(doc, "duration", "alt"); err != nil {
			return 0, err
		}
	}
	if op.Entity == "run" {
		if err := s.validateRun(ctx, tx, actor, id, doc); err != nil {
			return 0, err
		}
	}
	next, data, err := s.upsertDocument(ctx, tx, op.Entity, id, revision, doc)
	if err != nil {
		return 0, err
	}
	if err = s.projectDocument(ctx, tx, op.Entity, id, data); err != nil {
		return 0, err
	}
	if op.Entity == "checklist" {
		business := intValue(doc["version"])
		if _, err = tx.Exec(ctx, "INSERT INTO checklist_versions(checklist_id,version,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", id, business, data); err != nil {
			return 0, err
		}
	}
	s.audit(ctx, tx, actor.ID, op.Entity, id, "upsert")
	return next, nil
}
func (s *server) audit(ctx context.Context, tx pgx.Tx, actorID, entity, entityID, action string) {
	_, _ = tx.Exec(ctx, "INSERT INTO audit_log(actor_id,entity,entity_id,action) VALUES($1,$2,$3,$4)", actorID, entity, entityID, action)
}
func (s *server) updateMe(c *gin.Context) {
	var in struct {
		Name  string `json:"name"`
		Phone string `json:"phone"`
	}
	if err := c.ShouldBindJSON(&in); err != nil || strings.TrimSpace(in.Name) == "" {
		status := http.StatusBadRequest
		if err != nil {
			status = invalidJSONStatus(err)
		}
		c.JSON(status, gin.H{"error": "name is required"})
		return
	}
	u := current(c)
	if _, err := s.db.Exec(c, "UPDATE users SET name=$2,phone=$3,updated_at=now() WHERE id=$1", u.ID, in.Name, in.Phone); err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *server) createUser(c *gin.Context) {
	if !admin(c) {
		return
	}
	var u user
	if err := c.ShouldBindJSON(&u); err != nil || strings.TrimSpace(u.Name) == "" {
		status := http.StatusBadRequest
		if err != nil {
			status = invalidJSONStatus(err)
		}
		c.JSON(status, gin.H{"error": "name is required"})
		return
	}
	u.ID = newID()
	if u.Status == "" {
		u.Status = "приглашён"
	}
	roles, err := s.allowedRoles(current(c), u.Roles, "")
	if err != nil {
		c.JSON(403, gin.H{"error": err.Error()})
		return
	}
	u.Roles = decodeRoles(roles)
	raw := token()
	_, err = s.db.Exec(c, "INSERT INTO users(id,name,position,roles,phone,status,access_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", u.ID, u.Name, u.Position, roles, u.Phone, u.Status, tokenHash(raw))
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.JSON(201, gin.H{"user": u, "accessUrl": s.accessURL(raw)})
}
func (s *server) updateUser(c *gin.Context) {
	if !admin(c) {
		return
	}
	var u user
	if err := c.ShouldBindJSON(&u); err != nil || strings.TrimSpace(u.Name) == "" {
		status := http.StatusBadRequest
		if err != nil {
			status = invalidJSONStatus(err)
		}
		c.JSON(status, gin.H{"error": "name is required"})
		return
	}
	tag := c.Param("id")
	roles, err := s.allowedRoles(current(c), u.Roles, tag)
	if err != nil {
		c.JSON(403, gin.H{"error": err.Error()})
		return
	}
	if u.Status != "активен" && u.Status != "приглашён" && u.Status != "деактивирован" {
		c.JSON(400, gin.H{"error": "unknown status"})
		return
	}
	var previousRoles, previousStatus string
	if err := s.db.QueryRow(c, "SELECT roles,status FROM users WHERE id=$1", tag).Scan(&previousRoles, &previousStatus); err != nil {
		c.JSON(404, gin.H{"error": "user not found"})
		return
	}
	// An administrator may edit a colleague's contact card, but only the owner
	// can change an administrator's access state. Otherwise deactivation would
	// be a role demotion in all but name.
	if contains(decodeRoles(previousRoles), "администратор") && !hasRole(current(c), "владелец") && u.Status != previousStatus {
		c.JSON(403, gin.H{"error": "only owner may change administrator access"})
		return
	}
	result, err := s.db.Exec(c, "UPDATE users SET name=$2,position=$3,roles=$4,phone=$5,status=$6,updated_at=now(),access_hash=CASE WHEN $6='деактивирован' THEN NULL ELSE access_hash END,access_revoked_at=CASE WHEN $6='деактивирован' THEN now() ELSE access_revoked_at END WHERE id=$1", tag, u.Name, u.Position, roles, u.Phone, u.Status)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	if result.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "user not found"})
		return
	}
	c.Status(204)
}

func (s *server) mayChangeAdminLink(c *gin.Context, target string) bool {
	var roles string
	if err := s.db.QueryRow(c, "SELECT roles FROM users WHERE id=$1", target).Scan(&roles); err != nil {
		c.JSON(404, gin.H{"error": "user not found"})
		return false
	}
	actor := current(c)
	// An administrator cannot invalidate a colleague administrator's credential.
	// Their own credential is an exception: rotating it does not grant a role or
	// alter anybody else's access and lets a user recover a leaked link.
	if contains(decodeRoles(roles), "администратор") && !hasRole(actor, "владелец") && actor.ID != target {
		c.JSON(403, gin.H{"error": "only owner may change administrator access link"})
		return false
	}
	return true
}
func (s *server) regenerateLink(c *gin.Context) {
	if !admin(c) {
		return
	}
	raw := token()
	tag := c.Param("id")
	if !s.mayChangeAdminLink(c, tag) {
		return
	}
	// Deactivated staff stays in history but must not receive a fresh credential.
	cmd, err := s.db.Exec(c, "UPDATE users SET access_hash=$2,access_revoked_at=NULL,updated_at=now() WHERE id=$1 AND status IN ('активен','приглашён')", tag, tokenHash(raw))
	if err != nil || cmd.RowsAffected() == 0 {
		c.JSON(409, gin.H{"error": "access link cannot be issued for a deactivated or missing user"})
		return
	}
	c.JSON(200, gin.H{"accessUrl": s.accessURL(raw)})
}
func (s *server) revokeLink(c *gin.Context) {
	if !admin(c) {
		return
	}
	tag := c.Param("id")
	if !s.mayChangeAdminLink(c, tag) {
		return
	}
	cmd, err := s.db.Exec(c, "UPDATE users SET access_hash=NULL,access_revoked_at=now(),updated_at=now() WHERE id=$1", tag)
	if err != nil || cmd.RowsAffected() == 0 {
		c.JSON(404, gin.H{"error": "user not found"})
		return
	}
	c.Status(204)
}
func (s *server) transferOwnership(c *gin.Context) {
	actor := current(c)
	if !contains(actor.Roles, "владелец") {
		c.JSON(403, gin.H{"error": "owner role is required"})
		return
	}
	target := c.Param("id")
	tx, err := s.db.Begin(c)
	if err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	defer tx.Rollback(c)
	var roles, status string
	if err := tx.QueryRow(c, "SELECT roles,status FROM users WHERE id=$1 FOR UPDATE", target).Scan(&roles, &status); err != nil || status != "активен" {
		c.JSON(400, gin.H{"error": "target must be an active user"})
		return
	}
	if contains(decodeRoles(roles), "владелец") {
		c.Status(204)
		return
	}
	if _, err = tx.Exec(c, "UPDATE users SET roles=trim(both ', ' from replace(roles,'владелец','')),updated_at=now() WHERE roles LIKE '%владелец%'"); err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	newRoles, _ := encodeRoles(append([]string{"владелец"}, decodeRoles(roles)...))
	if _, err = tx.Exec(c, "UPDATE users SET roles=$2,updated_at=now() WHERE id=$1", target, newRoles); err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	s.audit(c, tx, actor.ID, "user", target, "transfer_ownership")
	if err = tx.Commit(c); err != nil {
		c.JSON(500, gin.H{"error": "database error"})
		return
	}
	c.Status(204)
}
