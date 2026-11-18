package main

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jamjallred/sf_car_database/internal/database"
)

type carJSON struct {
	State     string            `json:"state"`
	City      string            `json:"city"`
	Year      string            `json:"year"`
	Make      string            `json:"make"`
	Model     string            `json:"model"`
	Trim      string            `json:"trim"`
	Drive     string            `json:"drive"`
	VIN       string            `json:"vin"`
	Color     string            `json:"color"`
	Miles     int32             `json:"miles"`
	Price     int32             `json:"price"`
	MSRP      int32             `json:"msrp"`
	UpdatedAt *time.Time        `json:"updatedAt,omitempty"`
	Dibs      []dibJSON         `json:"dibs"`     // oldest first
	Notes     map[string]string `json:"notes"`    // person → note
	InLatest  bool              `json:"inLatest"` // on the most recent nationwide sheet
}

type importJSON struct {
	ID   int64     `json:"id"`
	At   time.Time `json:"at"`
	Cars int32     `json:"cars"`
}

type carsPage struct {
	Cars      []carJSON `json:"cars"`
	Total     int64     `json:"total"`
	Limit     int32     `json:"limit"`
	Offset    int32     `json:"offset"`
	DibsNames []string  `json:"dibsNames"`
	// The most recent nationwide sheet saved, and whether this page is limited
	// to its cars ("latest") or includes older ones ("all").
	Latest *importJSON `json:"latest,omitempty"`
	Scope  string      `json:"scope"`
	// Pasted VINs that aren't in the cars table at all (only set when vins is).
	NotFound []string `json:"notFound,omitempty"`
}

// GET /api/cars?q=&state=&vins=A,B&scope=latest&limit=50&offset=0
//
// q matches VIN, make, model or city (case-insensitive substring). vins is an
// exact VIN list separated by commas, semicolons or whitespace. A q containing
// commas is treated as vins. limit=all returns every matching car.
//
// Without a search (q or vins), only the cars of the most recent nationwide
// sheet are returned, unless scope=all. A search always covers every car.
func (cfg *apiConfig) handlerSearchCars(w http.ResponseWriter, r *http.Request) {
	qs := r.URL.Query()

	search := strings.TrimSpace(qs.Get("q"))
	vinList := qs.Get("vins")
	if strings.Contains(search, ",") {
		vinList, search = search, ""
	}
	vins := splitVINs(vinList)

	limit := clampInt(qs.Get("limit"), 50, 1, 500)
	if qs.Get("limit") == "all" {
		limit = math.MaxInt32
	}
	offset := clampInt(qs.Get("offset"), 0, 0, 1<<30)

	ctx := r.Context()
	latest, err := cfg.latestImport(ctx)
	if err != nil {
		respondErr(w, r, err, "could not load inventory")
		return
	}
	scope := "all"
	var importID *int64
	if latest != nil && search == "" && len(vins) == 0 && qs.Get("scope") != "all" {
		scope = "latest"
		importID = &latest.ID
	}

	filter := database.CountCarsParams{
		Search:   optional(search),
		State:    optional(strings.TrimSpace(qs.Get("state"))),
		Vins:     vins, // nil means "no VIN filter"
		ImportID: importID,
	}

	total, err := cfg.dbQueries.CountCars(ctx, filter)
	if err != nil {
		respondErr(w, r, err, "could not load inventory")
		return
	}
	cars, err := cfg.dbQueries.SearchCars(ctx, database.SearchCarsParams{
		Search:   filter.Search,
		State:    filter.State,
		Vins:     filter.Vins,
		ImportID: filter.ImportID,
		Lim:      limit,
		Off:      offset,
	})
	if err != nil {
		respondErr(w, r, err, "could not load inventory")
		return
	}

	pageVINs := make([]string, len(cars))
	for i, c := range cars {
		pageVINs[i] = c.Vin
	}
	dibs, err := cfg.dibsFor(ctx, cfg.dbQueries, pageVINs)
	if err != nil {
		respondErr(w, r, err, "could not load dibs")
		return
	}
	notes, err := notesFor(ctx, cfg.dbQueries, pageVINs)
	if err != nil {
		respondErr(w, r, err, "could not load notes")
		return
	}

	page := carsPage{
		Cars: make([]carJSON, 0, len(cars)), Total: total, Limit: limit, Offset: offset,
		DibsNames: dibsNames, Latest: latest, Scope: scope,
	}
	if len(vins) > 0 {
		existing, err := cfg.dbQueries.ExistingVins(ctx, vins)
		if err != nil {
			respondErr(w, r, err, "could not load inventory")
			return
		}
		found := make(map[string]bool, len(existing))
		for _, v := range existing {
			found[v] = true
		}
		for _, v := range vins {
			if !found[v] {
				page.NotFound = append(page.NotFound, v)
			}
		}
	}
	for _, c := range cars {
		page.Cars = append(page.Cars, toCarJSON(c, dibs[c.Vin], notes[c.Vin], latest))
	}
	writeJSON(w, http.StatusOK, page)
}

// toCarJSON converts a car row, with its dibs and notes, for the page.
func toCarJSON(c database.Car, dibs []dibJSON, notes map[string]string, latest *importJSON) carJSON {
	cj := carJSON{
		State: c.State, City: c.City, Year: c.Year, Make: c.Make, Model: c.Model,
		Trim: c.Trim, Drive: c.Drive, VIN: c.Vin, Color: c.Color,
		Miles: c.Miles, Price: c.Price, MSRP: c.Msrp,
		Dibs: dibs, Notes: notes,
		InLatest: latest != nil && c.LastImportID != nil && *c.LastImportID == latest.ID,
	}
	if cj.Dibs == nil {
		cj.Dibs = []dibJSON{}
	}
	if cj.Notes == nil {
		cj.Notes = map[string]string{}
	}
	if c.Timestamp.Valid {
		t := c.Timestamp.Time
		cj.UpdatedAt = &t
	}
	return cj
}

// latestImport returns the most recent nationwide import, or nil if there's none.
func (cfg *apiConfig) latestImport(ctx context.Context) (*importJSON, error) {
	li, err := cfg.dbQueries.LatestImport(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &importJSON{ID: li.ID, At: li.CreatedAt.Time, Cars: li.Cars}, nil
}

// GET /api/cars/states — distinct states for the filter dropdown.
func (cfg *apiConfig) handlerListStates(w http.ResponseWriter, r *http.Request) {
	states, err := cfg.dbQueries.ListStates(r.Context())
	if err != nil {
		respondErr(w, r, err, "could not load states")
		return
	}
	if states == nil {
		states = []string{}
	}
	writeJSON(w, http.StatusOK, map[string][]string{"states": states})
}

// splitVINs splits a pasted VIN list on commas, semicolons and whitespace,
// upper-cases each VIN and drops duplicates, keeping the pasted order.
func splitVINs(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || unicode.IsSpace(r)
	})
	var vins []string
	seen := make(map[string]bool, len(fields))
	for _, v := range fields {
		v = strings.ToUpper(strings.Trim(v, `"'`))
		if v != "" && !seen[v] {
			seen[v] = true
			vins = append(vins, v)
		}
	}
	return vins
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func clampInt(raw string, def, lo, hi int32) int32 {
	n, err := strconv.ParseInt(raw, 10, 32)
	if err != nil {
		return def
	}
	return max(lo, min(hi, int32(n)))
}
