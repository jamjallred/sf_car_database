package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jamjallred/sf_car_database/internal/database"
)

// dibsNames are the inventory page's dibs columns, in display order.
var dibsNames = []string{"Mike", "Stan", "Jaxon", "Gregg"}

// waveName is the "2nd Wave" checkbox column. Its ticks come through
// /api/dibs like a dibs column's, but are kept in car_second_wave: they have
// no order and don't count as dibs.
const waveName = "2nd Wave"

type waveJSON struct {
	By string    `json:"by"`
	At time.Time `json:"at"`
}

const maxDibsChanges = 10000

type dibJSON struct {
	Name string    `json:"name"`
	At   time.Time `json:"at"`
}

type dibsChange struct {
	VIN   string `json:"vin"`
	Name  string `json:"name"`
	Claim bool   `json:"claim"` // false releases the dibs
}

type dibsRequest struct {
	CalledBy string       `json:"calledBy"` // the profile chosen in the header
	Changes  []dibsChange `json:"changes"`
}

type dibsResponse struct {
	Claimed     int                  `json:"claimed"`
	Released    int                  `json:"released"`
	WaveSet     int                  `json:"waveSet"`     // cars ticked 2nd Wave
	WaveCleared int                  `json:"waveCleared"` // cars unticked
	Dibs        map[string][]dibJSON `json:"dibs"`        // current dibs of every VIN in the request
	Wave        map[string]*waveJSON `json:"wave"`        // current 2nd Wave of every VIN (null: not ticked)
}

// dibsFor returns each VIN's dibs, oldest first.
func (cfg *apiConfig) dibsFor(ctx context.Context, q *database.Queries, vins []string) (map[string][]dibJSON, error) {
	out := make(map[string][]dibJSON, len(vins))
	if len(vins) == 0 {
		return out, nil
	}
	rows, err := q.ListDibsForVins(ctx, vins)
	if err != nil {
		return nil, err
	}
	for _, d := range rows {
		out[d.Vin] = append(out[d.Vin], dibJSON{Name: d.Claimant, At: d.ClaimedAt.Time})
	}
	return out, nil
}

// waveFor returns the 2nd Wave tick of each VIN that has one.
func waveFor(ctx context.Context, q *database.Queries, vins []string) (map[string]*waveJSON, error) {
	out := make(map[string]*waveJSON, len(vins))
	if len(vins) == 0 {
		return out, nil
	}
	rows, err := q.ListSecondWaveForVins(ctx, vins)
	if err != nil {
		return nil, err
	}
	for _, w := range rows {
		out[w.Vin] = &waveJSON{By: w.SetBy, At: w.SetAt.Time}
	}
	return out, nil
}

// requireVINs returns a clientError naming the first VIN that isn't in cars.
func requireVINs(ctx context.Context, q *database.Queries, vins []string) error {
	existing, err := q.ExistingVins(ctx, vins)
	if err != nil || len(existing) == len(vins) {
		return err
	}
	known := make(map[string]bool, len(existing))
	for _, v := range existing {
		known[v] = true
	}
	for _, v := range vins {
		if !known[v] {
			return badRequest("VIN %s isn't in the inventory; nothing was saved", v)
		}
	}
	return nil
}

// POST /api/dibs — {calledBy, changes: [{vin, name, claim}]}
//
// name is a dibs column, or "2nd Wave" to tick (claim) or untick that box.
// Claims keep their original time if the person already has dibs, so
// re-submitting never moves anyone down the order. Changes are applied in the
// order given, in one transaction.
func (cfg *apiConfig) handlerDibs(w http.ResponseWriter, r *http.Request) {
	var req dibsRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		respondErr(w, r, badRequest("couldn't read the dibs request"), "")
		return
	}
	if len(req.Changes) == 0 {
		respondErr(w, r, badRequest("no dibs to save"), "")
		return
	}
	if len(req.Changes) > maxDibsChanges {
		respondErr(w, r, badRequest("too many changes at once (max %d)", maxDibsChanges), "")
		return
	}

	var vins []string
	seen := map[string]bool{}
	for i := range req.Changes {
		c := &req.Changes[i]
		c.VIN = strings.ToUpper(strings.TrimSpace(c.VIN))
		if c.VIN == "" {
			respondErr(w, r, badRequest("a change is missing its VIN"), "")
			return
		}
		if c.Name != waveName && !slices.Contains(dibsNames, c.Name) {
			respondErr(w, r, badRequest("%q isn't one of the dibs columns", c.Name), "")
			return
		}
		if !seen[c.VIN] {
			seen[c.VIN] = true
			vins = append(vins, c.VIN)
		}
	}
	calledBy := strings.TrimSpace(req.CalledBy)

	ctx := r.Context()
	tx, err := cfg.db.Begin(ctx)
	if err != nil {
		respondErr(w, r, err, "could not reach the database")
		return
	}
	defer tx.Rollback(ctx) // no-op after Commit
	q := cfg.dbQueries.WithTx(tx)

	if err := requireVINs(ctx, q, vins); err != nil {
		respondErr(w, r, err, "could not save dibs")
		return
	}

	now := pgtype.Timestamp{Time: time.Now().UTC(), Valid: true}
	var res dibsResponse
	for _, c := range req.Changes {
		var n int64
		action := "claim"
		switch {
		case c.Name == waveName && c.Claim:
			n, err = q.SetSecondWave(ctx, database.SetSecondWaveParams{Vin: c.VIN, SetBy: calledBy, SetAt: now})
			res.WaveSet += int(n)
		case c.Name == waveName:
			action = "release"
			n, err = q.ClearSecondWave(ctx, c.VIN)
			res.WaveCleared += int(n)
		case c.Claim:
			n, err = q.ClaimDibs(ctx, database.ClaimDibsParams{Vin: c.VIN, Claimant: c.Name, CalledBy: calledBy, ClaimedAt: now})
			res.Claimed += int(n)
		default:
			action = "release"
			n, err = q.ReleaseDibs(ctx, database.ReleaseDibsParams{Vin: c.VIN, Claimant: c.Name})
			res.Released += int(n)
		}
		if err == nil && n > 0 {
			err = q.LogDibs(ctx, database.LogDibsParams{Vin: c.VIN, Claimant: c.Name, Action: action, CalledBy: calledBy, At: now})
		}
		if err != nil {
			respondErr(w, r, fmt.Errorf("%s %s on %s: %w", action, c.Name, c.VIN, err), "could not save dibs; nothing was saved")
			return
		}
	}

	res.Dibs, err = cfg.dibsFor(ctx, q, vins)
	if err != nil {
		respondErr(w, r, err, "could not save dibs")
		return
	}
	if res.Wave, err = waveFor(ctx, q, vins); err != nil {
		respondErr(w, r, err, "could not save dibs")
		return
	}
	for _, v := range vins {
		if _, ok := res.Wave[v]; !ok {
			res.Wave[v] = nil // so the page learns the box is now unticked
		}
		if res.Dibs[v] == nil {
			res.Dibs[v] = []dibJSON{}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		respondErr(w, r, err, "could not save dibs")
		return
	}
	writeJSON(w, http.StatusOK, res)
}
