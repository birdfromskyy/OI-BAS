package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRoleEncodingAndAuthorization(t *testing.T) {
	encoded, err := encodeRoles([]string{" пилот ", "пилот", "наблюдатель"})
	if err != nil || encoded != "пилот, наблюдатель" {
		t.Fatalf("encoded roles = %q, %v", encoded, err)
	}
	if got := decodeRoles("пилот, неизвестная, наблюдатель, пилот"); !sameRoles(got, []string{"пилот", "наблюдатель"}) {
		t.Fatalf("decoded roles = %#v", got)
	}
	if _, err := encodeRoles([]string{"техник"}); err == nil {
		t.Fatal("unknown role was accepted")
	}
	if !hasRole(user{Roles: []string{"владелец"}}, "администратор") {
		t.Fatal("owner must inherit administrator privileges")
	}
	if hasRole(user{Roles: []string{"наблюдатель"}}, "администратор") {
		t.Fatal("observer received administrator privileges")
	}
}

func TestIdentifiersAndTokenHash(t *testing.T) {
	id := newID()
	if !isUUID(id) {
		t.Fatalf("newID returned invalid UUID: %q", id)
	}
	raw := token()
	if len(raw) != 64 {
		t.Fatalf("token length = %d, want 64", len(raw))
	}
	if bytes.Equal(tokenHash(raw), []byte(raw)) || len(tokenHash(raw)) != 32 {
		t.Fatal("access token is not stored as SHA-256")
	}
}

func TestAccessURLUsesFragment(t *testing.T) {
	s := &server{cfg: config{baseURL: "https://oi-bas.space"}}
	if got := s.accessURL("secret"); got != "https://oi-bas.space/#access=secret" {
		t.Fatalf("access URL = %q", got)
	}
}

// Set TEST_DATABASE_URL to a disposable PostgreSQL connection to run this
// end-to-end suite. It creates and drops a private schema, never tables in the
// configured application's public schema.
func TestAPIIntegration(t *testing.T) {
	baseURL := os.Getenv("TEST_DATABASE_URL")
	if baseURL == "" {
		t.Skip("TEST_DATABASE_URL is not configured")
	}
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	adminConn, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Fatal(err)
	}
	schemaName := "test_" + strings.ReplaceAll(newID(), "-", "")
	if _, err = adminConn.Exec(ctx, "CREATE SCHEMA "+schemaName); err != nil {
		t.Fatal(err)
	}

	poolConfig, err := pgxpool.ParseConfig(baseURL)
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schemaName
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{db: pool, cfg: config{baseURL: "http://test.local"}}
	if err = s.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = adminConn.Exec(ctx, "DROP SCHEMA "+schemaName+" CASCADE")
		adminConn.Close(ctx)
	})

	adminToken := token()
	adminID := newID()
	if _, err = pool.Exec(ctx, "INSERT INTO users(id,name,roles,status,access_hash) VALUES($1,$2,$3,$4,$5)", adminID, "Owner", "владелец, администратор", "активен", tokenHash(adminToken)); err != nil {
		t.Fatal(err)
	}
	router := s.router()

	bootstrap := request(t, router, http.MethodGet, "/api/v1/bootstrap", adminToken, nil)
	if bootstrap.Code != http.StatusOK {
		t.Fatalf("bootstrap: %d %s", bootstrap.Code, bootstrap.Body.String())
	}

	created := request(t, router, http.MethodPost, "/api/v1/users", adminToken, map[string]any{"name": "Pilot", "roles": []string{"пилот"}, "phone": "+70000000000", "status": "приглашён"})
	if created.Code != http.StatusCreated {
		t.Fatalf("create user: %d %s", created.Code, created.Body.String())
	}
	var createdBody struct {
		User      user   `json:"user"`
		AccessURL string `json:"accessUrl"`
	}
	decodeBody(t, created, &createdBody)
	if createdBody.User.ID == "" || !sameRoles(createdBody.User.Roles, []string{"пилот"}) {
		t.Fatalf("unexpected created user: %#v", createdBody.User)
	}
	pilotToken := accessFromURL(t, createdBody.AccessURL)
	var hashSize int
	if err := pool.QueryRow(ctx, "SELECT octet_length(access_hash) FROM users WHERE id=$1", createdBody.User.ID).Scan(&hashSize); err != nil || hashSize != 32 {
		t.Fatalf("access hash: %d, %v", hashSize, err)
	}
	me := request(t, router, http.MethodPut, "/api/v1/me", adminToken, map[string]any{"name": "Owner Updated", "phone": "+79990000000"})
	if me.Code != http.StatusNoContent {
		t.Fatalf("update me: %d %s", me.Code, me.Body.String())
	}

	aircraftID := newID()
	pilotAircraftData := map[string]any{"id": aircraftID, "model": "Pilot aircraft", "status": "годен", "hours": 0, "flights": 0, "service": 0, "serviced": 0}
	pilotAircraft := syncOne(t, router, pilotToken, "aircraft", pilotAircraftData)
	if pilotAircraft.Code != http.StatusOK {
		t.Fatalf("pilot created aircraft: %d %s", pilotAircraft.Code, pilotAircraft.Body.String())
	}
	pilotAircraftData["revision"] = syncRevision(t, pilotAircraft)
	// Пилот имеет CRU к БВС и аккумуляторам; окончательное удаление БВС
	// остаётся у администратора и владельца.
	if denied := syncDelete(t, router, pilotToken, "aircraft", aircraftID, intValue(pilotAircraftData["revision"])); denied.Code != http.StatusConflict {
		t.Fatalf("pilot deleted aircraft through API: %d %s", denied.Code, denied.Body.String())
	}
	pilotBatteryID := newID()
	pilotBattery := syncOne(t, router, pilotToken, "battery", map[string]any{"id": pilotBatteryID, "serial": "TB65-pilot", "status": "в строю", "started": "2026-09-09", "checked": "2026-09-09", "checkedAt": "10:00:00", "capacity": 100, "capacityNow": 100, "output": 10, "outputNow": 10})
	if pilotBattery.Code != http.StatusOK {
		t.Fatalf("pilot changed battery: %d %s", pilotBattery.Code, pilotBattery.Body.String())
	}
	batteryID := newID()
	adminBattery := syncOne(t, router, adminToken, "battery", map[string]any{"id": batteryID, "serial": "TB65-test", "status": "в строю"})
	if adminBattery.Code != http.StatusOK {
		t.Fatalf("admin battery: %d %s", adminBattery.Code, adminBattery.Body.String())
	}
	var withBatteries struct {
		Batteries []struct {
			ID string `json:"id"`
		} `json:"batteries"`
	}
	decodeBody(t, request(t, router, http.MethodGet, "/api/v1/bootstrap", adminToken, nil), &withBatteries)
	foundBattery := false
	for _, battery := range withBatteries.Batteries {
		foundBattery = foundBattery || battery.ID == batteryID
	}
	if !foundBattery {
		t.Fatalf("battery is absent from bootstrap: %#v", withBatteries.Batteries)
	}
	checklistID := newID()
	pilotChecklist := syncOne(t, router, pilotToken, "checklist", map[string]any{"id": checklistID, "aircraftId": aircraftID, "model": "Pilot aircraft", "version": 1, "title": "Pilot checklist", "author": "Pilot", "items": []any{}})
	if pilotChecklist.Code != http.StatusOK {
		t.Fatalf("pilot checklist: %d %s", pilotChecklist.Code, pilotChecklist.Body.String())
	}
	checklistRevision := syncRevision(t, pilotChecklist)
	today := businessToday().Format("2006-01-02")
	tomorrow := businessToday().AddDate(0, 0, 1).Format("2006-01-02")
	flightID := newID()
	flightData := map[string]any{"id": flightID, "date": today, "pilotId": createdBody.User.ID, "pilot": "Pilot", "aircraftId": aircraftID, "aircraft": "Pilot aircraft", "checklistId": checklistID, "checklist": "Pilot checklist", "runId": "", "site": "", "siteId": "", "status": "запланирован", "task": "Test", "takeoff": "", "landing": "", "duration": 0, "alt": 0, "notes": []any{}}
	pastFlight := make(map[string]any, len(flightData))
	for key, value := range flightData {
		pastFlight[key] = value
	}
	pastFlight["id"] = newID()
	pastFlight["date"] = businessToday().AddDate(0, 0, -1).Format("2006-01-02")
	if rejected := syncOne(t, router, adminToken, "flight", pastFlight); rejected.Code != http.StatusConflict {
		t.Fatalf("past scheduled flight was accepted: %d %s", rejected.Code, rejected.Body.String())
	}
	adminFlight := syncOne(t, router, adminToken, "flight", flightData)
	if adminFlight.Code != http.StatusOK {
		t.Fatalf("admin flight: %d %s", adminFlight.Code, adminFlight.Body.String())
	}
	flightData["revision"] = syncRevision(t, adminFlight)
	// An invited pilot may be selected even before they open their personal link.
	invited := request(t, router, http.MethodPost, "/api/v1/users", adminToken, map[string]any{"name": "Invited pilot", "roles": []string{"пилот"}, "status": "приглашён"})
	if invited.Code != http.StatusCreated {
		t.Fatalf("create invited pilot: %d %s", invited.Code, invited.Body.String())
	}
	var invitedBody struct {
		User user `json:"user"`
	}
	decodeBody(t, invited, &invitedBody)
	invitedFlight := make(map[string]any, len(flightData))
	for key, value := range flightData {
		invitedFlight[key] = value
	}
	invitedFlight["id"] = newID()
	invitedFlight["pilotId"] = invitedBody.User.ID
	invitedFlight["pilot"] = invitedBody.User.Name
	invitedFlight["date"] = tomorrow
	if scheduled := syncOne(t, router, adminToken, "flight", invitedFlight); scheduled.Code != http.StatusOK {
		t.Fatalf("scheduled flight for invited pilot: %d %s", scheduled.Code, scheduled.Body.String())
	}

	// Another active pilot may perform preparation, but may not record takeoff
	// for the person assigned to the flight.
	helper := request(t, router, http.MethodPost, "/api/v1/users", adminToken, map[string]any{"name": "Preparation pilot", "roles": []string{"пилот"}, "status": "приглашён"})
	if helper.Code != http.StatusCreated {
		t.Fatalf("create preparation pilot: %d %s", helper.Code, helper.Body.String())
	}
	var helperBody struct {
		User      user   `json:"user"`
		AccessURL string `json:"accessUrl"`
	}
	decodeBody(t, helper, &helperBody)
	helperToken := accessFromURL(t, helperBody.AccessURL)
	if activation := request(t, router, http.MethodGet, "/api/v1/bootstrap", helperToken, nil); activation.Code != http.StatusOK {
		t.Fatalf("activate preparation pilot: %d %s", activation.Code, activation.Body.String())
	}
	flightData["status"] = "подготовка пройдена"
	pilotFlight := syncOne(t, router, helperToken, "flight", flightData)
	if pilotFlight.Code != http.StatusOK {
		t.Fatalf("another pilot prepares flight: %d %s", pilotFlight.Code, pilotFlight.Body.String())
	}
	preparedFlightRevision := syncRevision(t, pilotFlight)
	run := syncOne(t, router, helperToken, "run", map[string]any{"id": newID(), "flightId": flightID, "checklistId": checklistID, "date": today, "signature": "Preparation pilot"})
	if run.Code != http.StatusOK {
		t.Fatalf("another pilot run: %d %s", run.Code, run.Body.String())
	}
	flightData["revision"] = preparedFlightRevision
	flightData["status"] = "выполняется"
	if rejected := syncOne(t, router, helperToken, "flight", flightData); rejected.Code != http.StatusConflict {
		t.Fatalf("unassigned pilot recorded takeoff: %d %s", rejected.Code, rejected.Body.String())
	}
	started := syncOne(t, router, pilotToken, "flight", flightData)
	if started.Code != http.StatusOK {
		t.Fatalf("assigned pilot recorded takeoff: %d %s", started.Code, started.Body.String())
	}
	runningFlightRevision := syncRevision(t, started)
	site := syncOne(t, router, pilotToken, "site", map[string]any{"id": newID(), "name": "Test site", "lat": 57.1, "lon": 65.5})
	if site.Code != http.StatusOK {
		t.Fatalf("pilot site: %d %s", site.Code, site.Body.String())
	}

	// A pilot may amend or delete anyone's *scheduled* flight, but cannot alter
	// a preparation/completed record. This is deliberately checked server-side,
	// independently from which buttons the browser happened to show.
	otherFlightID := newID()
	otherFlight := map[string]any{"id": otherFlightID, "date": tomorrow, "pilotId": adminID, "pilot": "Owner Updated", "aircraftId": aircraftID, "aircraft": "Pilot aircraft", "checklistId": checklistID, "checklist": "Pilot checklist", "runId": "", "site": "", "siteId": "", "status": "запланирован", "task": "Other pilot plan", "takeoff": "", "landing": "", "duration": 0, "alt": 0, "notes": []any{}}
	otherCreated := syncOne(t, router, adminToken, "flight", otherFlight)
	if otherCreated.Code != http.StatusOK {
		t.Fatalf("create another scheduled flight: %d %s", otherCreated.Code, otherCreated.Body.String())
	}
	otherFlight["revision"] = syncRevision(t, otherCreated)
	otherFlight["task"] = "Adjusted by another pilot"
	otherChanged := syncOne(t, router, pilotToken, "flight", otherFlight)
	if otherChanged.Code != http.StatusOK {
		t.Fatalf("pilot may amend any scheduled flight: %d %s", otherChanged.Code, otherChanged.Body.String())
	}
	if removed := syncDelete(t, router, pilotToken, "flight", otherFlightID, syncRevision(t, otherChanged)); removed.Code != http.StatusOK {
		t.Fatalf("pilot may delete any scheduled flight: %d %s", removed.Code, removed.Body.String())
	}

	if protectedChecklist := syncDelete(t, router, adminToken, "checklist", checklistID, checklistRevision); protectedChecklist.Code != http.StatusConflict {
		t.Fatalf("checklist used by a saved flight must be protected: %d %s", protectedChecklist.Code, protectedChecklist.Body.String())
	}
	if protectedAircraft := syncDelete(t, router, adminToken, "aircraft", aircraftID, intValue(pilotAircraftData["revision"])); protectedAircraft.Code != http.StatusConflict {
		t.Fatalf("aircraft with related records must be protected: %d %s", protectedAircraft.Code, protectedAircraft.Body.String())
	}

	// The limit is enforced in PostgreSQL's transaction, so offline creation on
	// several devices cannot create a fourth active checklist for the same BVS.
	for _, no := range []int{2, 3} {
		list := syncOne(t, router, pilotToken, "checklist", map[string]any{"id": newID(), "aircraftId": aircraftID, "model": "Pilot aircraft", "version": 1, "title": fmt.Sprintf("Checklist %d", no), "author": "Pilot", "items": []any{}})
		if list.Code != http.StatusOK {
			t.Fatalf("create checklist #%d: %d %s", no, list.Code, list.Body.String())
		}
	}
	fourthList := syncOne(t, router, pilotToken, "checklist", map[string]any{"id": newID(), "aircraftId": aircraftID, "model": "Pilot aircraft", "version": 1, "title": "Checklist 4", "author": "Pilot", "items": []any{}})
	if fourthList.Code != http.StatusConflict {
		t.Fatalf("fourth checklist was accepted: %d %s", fourthList.Code, fourthList.Body.String())
	}

	// A stale payload never wins over a newer server version. The local queue
	// will keep it blocked for explicit resolution instead of silently applying
	// last-write-wins.
	pilotAircraftData["model"] = "Pilot aircraft updated"
	updatedAircraft := syncOne(t, router, pilotToken, "aircraft", pilotAircraftData)
	if updatedAircraft.Code != http.StatusOK {
		t.Fatalf("update aircraft: %d %s", updatedAircraft.Code, updatedAircraft.Body.String())
	}
	staleAircraft := map[string]any{"id": aircraftID, "revision": 1, "model": "Stale overwrite", "status": "годен", "hours": 0, "flights": 0, "service": 0, "serviced": 0}
	if stale := syncOne(t, router, adminToken, "aircraft", staleAircraft); stale.Code != http.StatusConflict {
		t.Fatalf("stale update was accepted: %d %s", stale.Code, stale.Body.String())
	}

	// Closing a flight makes it immutable to a pilot, even if that pilot was
	// assigned to it. Administrators retain full journal management rights.
	flightData["revision"] = runningFlightRevision
	flightData["status"] = "завершён"
	completed := syncOne(t, router, adminToken, "flight", flightData)
	if completed.Code != http.StatusOK {
		t.Fatalf("owner completes flight: %d %s", completed.Code, completed.Body.String())
	}
	completedRevision := syncRevision(t, completed)
	flightData["revision"] = completedRevision
	flightData["task"] = "Attempt to edit completed flight"
	if forbidden := syncOne(t, router, pilotToken, "flight", flightData); forbidden.Code != http.StatusConflict {
		t.Fatalf("pilot edited completed flight: %d %s", forbidden.Code, forbidden.Body.String())
	}
	if forbidden := syncDelete(t, router, pilotToken, "flight", flightID, completedRevision); forbidden.Code != http.StatusConflict {
		t.Fatalf("pilot deleted completed flight: %d %s", forbidden.Code, forbidden.Body.String())
	}

	// An unused BVS is soft-deleted. Its row remains for audit purposes but it
	// is absent from bootstrap and can no longer be selected by new records.
	unusedAircraftID := newID()
	unusedAircraft := syncOne(t, router, adminToken, "aircraft", map[string]any{"id": unusedAircraftID, "model": "Unused", "status": "годен", "hours": 0, "flights": 0, "service": 0, "serviced": 0})
	if unusedAircraft.Code != http.StatusOK {
		t.Fatalf("create unused aircraft: %d %s", unusedAircraft.Code, unusedAircraft.Body.String())
	}
	if removed := syncDelete(t, router, adminToken, "aircraft", unusedAircraftID, syncRevision(t, unusedAircraft)); removed.Code != http.StatusOK {
		t.Fatalf("soft delete unused aircraft: %d %s", removed.Code, removed.Body.String())
	}
	var deletedAt *time.Time
	if err := pool.QueryRow(ctx, "SELECT deleted_at FROM aircraft WHERE id=$1", unusedAircraftID).Scan(&deletedAt); err != nil || deletedAt == nil {
		t.Fatalf("soft-deleted aircraft was physically lost: %v, %v", deletedAt, err)
	}

	// The owner alone may create, demote, deactivate, rotate or revoke an
	// administrator's access. A regular administrator can still manage pilots.
	office := request(t, router, http.MethodPost, "/api/v1/users", adminToken, map[string]any{"name": "Office admin", "roles": []string{"администратор"}})
	if office.Code != http.StatusCreated {
		t.Fatalf("owner creates administrator: %d %s", office.Code, office.Body.String())
	}
	var officeBody struct {
		User      user   `json:"user"`
		AccessURL string `json:"accessUrl"`
	}
	decodeBody(t, office, &officeBody)
	officeToken := accessFromURL(t, officeBody.AccessURL)
	if activeOffice := request(t, router, http.MethodGet, "/api/v1/bootstrap", officeToken, nil); activeOffice.Code != http.StatusOK {
		t.Fatalf("administrator link: %d %s", activeOffice.Code, activeOffice.Body.String())
	}
	secondAdmin := request(t, router, http.MethodPost, "/api/v1/users", adminToken, map[string]any{"name": "Protected admin", "roles": []string{"администратор"}})
	if secondAdmin.Code != http.StatusCreated {
		t.Fatalf("owner creates protected administrator: %d %s", secondAdmin.Code, secondAdmin.Body.String())
	}
	var secondAdminBody struct {
		User user `json:"user"`
	}
	decodeBody(t, secondAdmin, &secondAdminBody)
	if denied := request(t, router, http.MethodPut, "/api/v1/users/"+secondAdminBody.User.ID, officeToken, map[string]any{"name": "Protected admin", "roles": []string{"пилот"}, "status": "активен"}); denied.Code != http.StatusForbidden {
		t.Fatalf("administrator demoted colleague administrator: %d %s", denied.Code, denied.Body.String())
	}
	if denied := request(t, router, http.MethodDelete, "/api/v1/users/"+secondAdminBody.User.ID+"/access-link", officeToken, nil); denied.Code != http.StatusForbidden {
		t.Fatalf("administrator revoked colleague administrator link: %d %s", denied.Code, denied.Body.String())
	}
	renewed := request(t, router, http.MethodPost, "/api/v1/users/"+officeBody.User.ID+"/access-link", officeToken, nil)
	if renewed.Code != http.StatusOK {
		t.Fatalf("administrator could not rotate own link: %d %s", renewed.Code, renewed.Body.String())
	}
	var renewedOffice struct {
		AccessURL string `json:"accessUrl"`
	}
	decodeBody(t, renewed, &renewedOffice)
	officeToken = accessFromURL(t, renewedOffice.AccessURL)
	if denied := request(t, router, http.MethodPost, "/api/v1/users", officeToken, map[string]any{"name": "Forbidden admin", "roles": []string{"администратор"}}); denied.Code != http.StatusForbidden {
		t.Fatalf("administrator assigned another administrator: %d %s", denied.Code, denied.Body.String())
	}
	if demoted := request(t, router, http.MethodPut, "/api/v1/users/"+officeBody.User.ID, adminToken, map[string]any{"name": "Office admin", "roles": []string{"пилот"}, "status": "активен"}); demoted.Code != http.StatusNoContent {
		t.Fatalf("owner could not remove administrator role: %d %s", demoted.Code, demoted.Body.String())
	}

	observer := request(t, router, http.MethodPost, "/api/v1/users", adminToken, map[string]any{"name": "Observer", "roles": []string{"наблюдатель"}})
	if observer.Code != http.StatusCreated {
		t.Fatalf("create observer: %d %s", observer.Code, observer.Body.String())
	}
	var observerBody struct {
		AccessURL string `json:"accessUrl"`
	}
	decodeBody(t, observer, &observerBody)
	observerToken := accessFromURL(t, observerBody.AccessURL)
	if visible := request(t, router, http.MethodGet, "/api/v1/bootstrap", observerToken, nil); visible.Code != http.StatusOK {
		t.Fatalf("observer may read bootstrap: %d %s", visible.Code, visible.Body.String())
	}
	if denied := syncOne(t, router, observerToken, "battery", map[string]any{"id": newID(), "serial": "Observer write", "status": "в строю"}); denied.Code != http.StatusConflict {
		t.Fatalf("observer changed battery: %d %s", denied.Code, denied.Body.String())
	}

	// "Delete employee" in the interface is a soft deactivation: the staff
	// row and flight history remain, while its personal link is erased.
	deactivated := request(t, router, http.MethodPost, "/api/v1/users", adminToken, map[string]any{"name": "Deactivated", "roles": []string{"пилот"}})
	if deactivated.Code != http.StatusCreated {
		t.Fatalf("create user to deactivate: %d %s", deactivated.Code, deactivated.Body.String())
	}
	var deactivatedBody struct {
		User      user   `json:"user"`
		AccessURL string `json:"accessUrl"`
	}
	decodeBody(t, deactivated, &deactivatedBody)
	if stopped := request(t, router, http.MethodPut, "/api/v1/users/"+deactivatedBody.User.ID, adminToken, map[string]any{"name": "Deactivated", "roles": []string{"пилот"}, "status": "деактивирован"}); stopped.Code != http.StatusNoContent {
		t.Fatalf("deactivate employee: %d %s", stopped.Code, stopped.Body.String())
	}
	if denied := request(t, router, http.MethodGet, "/api/v1/bootstrap", accessFromURL(t, deactivatedBody.AccessURL), nil); denied.Code != http.StatusUnauthorized {
		t.Fatalf("deactivated employee link remained valid: %d", denied.Code)
	}
	var deactivatedHash []byte
	if err := pool.QueryRow(ctx, "SELECT access_hash FROM users WHERE id=$1", deactivatedBody.User.ID).Scan(&deactivatedHash); err != nil || deactivatedHash != nil {
		t.Fatalf("deactivation did not erase access hash: %v, %v", deactivatedHash, err)
	}
	if renewed := request(t, router, http.MethodPost, "/api/v1/users/"+deactivatedBody.User.ID+"/access-link", adminToken, nil); renewed.Code != http.StatusConflict {
		t.Fatalf("deactivated employee received a new link: %d %s", renewed.Code, renewed.Body.String())
	}

	updated := request(t, router, http.MethodPut, "/api/v1/users/"+createdBody.User.ID, adminToken, map[string]any{"name": "Pilot", "roles": []string{"наблюдатель"}, "phone": "+70000000000", "status": "активен"})
	if updated.Code != http.StatusNoContent {
		t.Fatalf("update role: %d %s", updated.Code, updated.Body.String())
	}
	profile := request(t, router, http.MethodGet, "/api/v1/bootstrap", pilotToken, nil)
	if profile.Code != http.StatusOK {
		t.Fatalf("pilot bootstrap: %d", profile.Code)
	}
	var profileBody struct {
		Profile sessionUser `json:"profile"`
	}
	decodeBody(t, profile, &profileBody)
	if !sameRoles(profileBody.Profile.Roles, []string{"наблюдатель"}) {
		t.Fatalf("role update not persisted: %#v", profileBody.Profile.Roles)
	}
	if profileBody.Profile.Status != "активен" {
		t.Fatalf("first valid link use must activate invite, got %q", profileBody.Profile.Status)
	}

	opID, idempotentAircraftID := newID(), newID()
	syncPayload := map[string]any{"operations": []any{map[string]any{"id": opID, "entity": "aircraft", "action": "upsert", "data": map[string]any{"id": idempotentAircraftID, "model": "Test aircraft", "status": "годен", "hours": 0, "flights": 0, "service": 0, "serviced": 0}}}}
	for attempt := 0; attempt < 2; attempt++ {
		response := request(t, router, http.MethodPost, "/api/v1/sync", adminToken, syncPayload)
		if response.Code != http.StatusOK {
			t.Fatalf("sync #%d: %d %s", attempt, response.Code, response.Body.String())
		}
		if attempt == 1 && syncRevision(t, response) != 1 {
			t.Fatal("replayed operation did not return its original revision")
		}
	}
	var aircraftCount, auditCount, batteryCount int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM aircraft WHERE deleted_at IS NULL").Scan(&aircraftCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM audit_log WHERE entity='aircraft' AND entity_id=$1", idempotentAircraftID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM batteries WHERE id=$1", batteryID).Scan(&batteryCount); err != nil {
		t.Fatal(err)
	}
	if aircraftCount != 2 || auditCount != 1 || batteryCount != 1 {
		t.Fatalf("sync must be idempotent: aircraft=%d audit=%d batteries=%d", aircraftCount, auditCount, batteryCount)
	}

	rotated := request(t, router, http.MethodPost, "/api/v1/users/"+createdBody.User.ID+"/access-link", adminToken, nil)
	if rotated.Code != http.StatusOK {
		t.Fatalf("regenerate link: %d %s", rotated.Code, rotated.Body.String())
	}
	var link struct {
		AccessURL string `json:"accessUrl"`
	}
	decodeBody(t, rotated, &link)
	if old := request(t, router, http.MethodGet, "/api/v1/bootstrap", pilotToken, nil); old.Code != http.StatusUnauthorized {
		t.Fatalf("old link remained valid: %d", old.Code)
	}
	newPilotToken := accessFromURL(t, link.AccessURL)
	if fresh := request(t, router, http.MethodGet, "/api/v1/bootstrap", newPilotToken, nil); fresh.Code != http.StatusOK {
		t.Fatalf("new link invalid: %d", fresh.Code)
	}
	if revoked := request(t, router, http.MethodDelete, "/api/v1/users/"+createdBody.User.ID+"/access-link", adminToken, nil); revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke: %d", revoked.Code)
	}
	if revokedAccess := request(t, router, http.MethodGet, "/api/v1/bootstrap", newPilotToken, nil); revokedAccess.Code != http.StatusUnauthorized {
		t.Fatalf("revoked link remained valid: %d", revokedAccess.Code)
	}
}

func request(t *testing.T, router http.Handler, method, path, access string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	if payload != nil {
		if err := json.NewEncoder(&body).Encode(payload); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &body)
	if access != "" {
		req.Header.Set("Authorization", "Bearer "+access)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	result := httptest.NewRecorder()
	router.ServeHTTP(result, req)
	return result
}
func syncOne(t *testing.T, router http.Handler, access, entity string, data map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, router, http.MethodPost, "/api/v1/sync", access, map[string]any{"operations": []any{map[string]any{"id": newID(), "entity": entity, "action": "upsert", "data": data}}})
}
func syncDelete(t *testing.T, router http.Handler, access, entity, id string, revision int) *httptest.ResponseRecorder {
	t.Helper()
	return request(t, router, http.MethodPost, "/api/v1/sync", access, map[string]any{"operations": []any{map[string]any{"id": newID(), "entity": entity, "action": "delete", "data": map[string]any{"id": id, "revision": revision}}}})
}
func syncRevision(t *testing.T, result *httptest.ResponseRecorder) int {
	t.Helper()
	var body struct {
		Applied []struct {
			Revision int `json:"revision"`
		} `json:"applied"`
	}
	decodeBody(t, result, &body)
	if len(body.Applied) != 1 || body.Applied[0].Revision < 1 {
		t.Fatalf("sync response has no revision: %s", result.Body.String())
	}
	return body.Applied[0].Revision
}
func decodeBody(t *testing.T, result *httptest.ResponseRecorder, into any) {
	t.Helper()
	if err := json.NewDecoder(result.Body).Decode(into); err != nil {
		t.Fatal(err)
	}
}
func accessFromURL(t *testing.T, value string) string {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	access := parsed.Query().Get("access")
	if access == "" {
		access = parsed.Fragment
		if values, err := url.ParseQuery(parsed.Fragment); err == nil {
			access = values.Get("access")
		}
	}
	if access == "" {
		t.Fatalf("invalid access URL")
	}
	return access
}
func sameRoles(got, want []string) bool { return strings.Join(got, ",") == strings.Join(want, ",") }
