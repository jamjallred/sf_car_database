package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jamjallred/sf_car_database/internal/database"
)

type carJSON struct {
	State     string     `json:"state"`
	City      string     `json:"city"`
	Year      string     `json:"year"`
	Make      string     `json:"make"`
	Model     string     `json:"model"`
	Trim      string     `json:"trim"`
	Drive     string     `json:"drive"`
	VIN       string     `json:"vin"`
	Color     string     `json:"color"`
	Miles     int32      `json:"miles"`
	Price     int32      `json:"price"`
	MSRP      int32      `json:"msrp"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
}

type carsPage struct {
	Cars   []carJSON `json:"cars"`
	Total  int64     `json:"total"`
	Limit  int32     `json:"limit"`
	Offset int32     `json:"offset"`
}

// GET /api/cars?q=&state=&vins=A,B&limit=50&offset=0
//
// q matches VIN, make, model or city (case-insensitive substring). vins is an
// exact comma-separated VIN list. A q containing commas is treated as vins.
func (cfg *apiConfig) handlerSearchCars(w http.ResponseWriter, r *http.Request) {
	qs := r.URL.Query()

	search := strings.TrimSpace(qs.Get("q"))
	vinList := qs.Get("vins")
	if strings.Contains(search, ",") {
		vinList, search = search, ""
	}

	var vins []string
	for _, v := range strings.Split(vinList, ",") {
		if v = strings.TrimSpace(v); v != "" {
			vins = append(vins, strings.ToUpper(v))
		}
	}

	limit := clampInt(qs.Get("limit"), 50, 1, 500)
	offset := clampInt(qs.Get("offset"), 0, 0, 1<<30)

	filter := database.CountCarsParams{
		Search: optional(search),
		State:  optional(strings.TrimSpace(qs.Get("state"))),
		Vins:   vins, // nil means "no VIN filter"
	}

	ctx := r.Context()
	total, err := cfg.dbQueries.CountCars(ctx, filter)
	if err != nil {
		respondErr(w, r, err, "could not load inventory")
		return
	}
	cars, err := cfg.dbQueries.SearchCars(ctx, database.SearchCarsParams{
		Search: filter.Search,
		State:  filter.State,
		Vins:   filter.Vins,
		Lim:    limit,
		Off:    offset,
	})
	if err != nil {
		respondErr(w, r, err, "could not load inventory")
		return
	}

	page := carsPage{Cars: make([]carJSON, 0, len(cars)), Total: total, Limit: limit, Offset: offset}
	for _, c := range cars {
		cj := carJSON{
			State: c.State, City: c.City, Year: c.Year, Make: c.Make, Model: c.Model,
			Trim: c.Trim, Drive: c.Drive, VIN: c.Vin, Color: c.Color,
			Miles: c.Miles, Price: c.Price, MSRP: c.Msrp,
		}
		if c.Timestamp.Valid {
			t := c.Timestamp.Time
			cj.UpdatedAt = &t
		}
		page.Cars = append(page.Cars, cj)
	}
	writeJSON(w, http.StatusOK, page)
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
