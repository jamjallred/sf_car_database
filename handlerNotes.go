package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jamjallred/sf_car_database/internal/database"
)

const maxNoteLen = 2000 // characters

type noteChange struct {
	VIN  string `json:"vin"`
	Name string `json:"name"` // one of dibsNames
	Note string `json:"note"` // "" deletes the note
}

type notesRequest struct {
	UpdatedBy string       `json:"updatedBy"` // the profile chosen in the header
	Changes   []noteChange `json:"changes"`
}

// notesFor returns each VIN's notes keyed by person.
func notesFor(ctx context.Context, q *database.Queries, vins []string) (map[string]map[string]string, error) {
	out := make(map[string]map[string]string, len(vins))
	if len(vins) == 0 {
		return out, nil
	}
	rows, err := q.ListNotesForVins(ctx, vins)
	if err != nil {
		return nil, err
	}
	for _, n := range rows {
		if out[n.Vin] == nil {
			out[n.Vin] = map[string]string{}
		}
		out[n.Vin][n.Claimant] = n.Note
	}
	return out, nil
}

// POST /api/notes — {updatedBy, changes: [{vin, name, note}]} → {notes}
//
// Saves every change in one transaction; later changes to the same cell win.
// The response has the current notes of every VIN in the request.
func (cfg *apiConfig) handlerNotes(w http.ResponseWriter, r *http.Request) {
	var req notesRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&req); err != nil {
		respondErr(w, r, badRequest("couldn't read the notes request"), "")
		return
	}
	if len(req.Changes) == 0 {
		respondErr(w, r, badRequest("no notes to save"), "")
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
		c.Note = strings.TrimSpace(c.Note)
		if c.VIN == "" {
			respondErr(w, r, badRequest("a note is missing its VIN"), "")
			return
		}
		if !slices.Contains(dibsNames, c.Name) {
			respondErr(w, r, badRequest("%q isn't one of the notes columns", c.Name), "")
			return
		}
		if utf8.RuneCountInString(c.Note) > maxNoteLen {
			respondErr(w, r, badRequest("the note for %s on %s is longer than %d characters", c.Name, c.VIN, maxNoteLen), "")
			return
		}
		if !seen[c.VIN] {
			seen[c.VIN] = true
			vins = append(vins, c.VIN)
		}
	}
	updatedBy := strings.TrimSpace(req.UpdatedBy)

	ctx := r.Context()
	tx, err := cfg.db.Begin(ctx)
	if err != nil {
		respondErr(w, r, err, "could not reach the database")
		return
	}
	defer tx.Rollback(ctx) // no-op after Commit
	q := cfg.dbQueries.WithTx(tx)

	if err := requireVINs(ctx, q, vins); err != nil {
		respondErr(w, r, err, "could not save notes")
		return
	}

	now := pgtype.Timestamp{Time: time.Now().UTC(), Valid: true}
	for _, c := range req.Changes {
		if c.Note == "" {
			err = q.DeleteNote(ctx, database.DeleteNoteParams{Vin: c.VIN, Claimant: c.Name})
		} else {
			err = q.UpsertNote(ctx, database.UpsertNoteParams{Vin: c.VIN, Claimant: c.Name, Note: c.Note, UpdatedBy: updatedBy, UpdatedAt: now})
		}
		if err != nil {
			respondErr(w, r, fmt.Errorf("note %s on %s: %w", c.Name, c.VIN, err), "could not save notes; nothing was saved")
			return
		}
	}

	notes, err := notesFor(ctx, q, vins)
	if err != nil {
		respondErr(w, r, err, "could not save notes")
		return
	}
	for _, v := range vins {
		if notes[v] == nil {
			notes[v] = map[string]string{}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		respondErr(w, r, err, "could not save notes")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes})
}
