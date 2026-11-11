package main

import (
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jamjallred/sf_car_database/internal/database"
	excelutils "github.com/jamjallred/sf_server_utils"
)

// Nationwide sheet columns (as produced by /api/create_sheet).
const (
	colState = iota
	colCity
	colYear
	colMake
	colModel
	colTrim
	colDrive
	colVIN
	colColor
	colMiles
	colPrice
	colMSRP
)

type saveResult struct {
	Inserted int      `json:"inserted"`
	Updated  int      `json:"updated"`
	Skipped  int      `json:"skipped"`
	Warnings []string `json:"warnings,omitempty"`
}

// POST /api/saveToDB — a nationwide sheet (.xlsx), as multipart field "file"
// or raw body. Cars are upserted by VIN in a single transaction.
func (cfg *apiConfig) handlerSaveToDB(w http.ResponseWriter, r *http.Request) {
	wb, err := readWorkbookUpload(w, r)
	if err != nil {
		respondErr(w, r, err, "")
		return
	}
	defer wb.Close()

	rows, err := wb.GetRows(wb.GetSheetName(0))
	if err != nil {
		respondErr(w, r, badRequest("couldn't read the first sheet"), "")
		return
	}
	if len(rows) < 2 {
		respondErr(w, r, badRequest("the sheet has no data rows"), "")
		return
	}

	ctx := r.Context()
	tx, err := cfg.db.Begin(ctx)
	if err != nil {
		respondErr(w, r, err, "could not reach the database")
		return
	}
	defer tx.Rollback(ctx) // no-op after Commit
	q := cfg.dbQueries.WithTx(tx)

	now := pgtype.Timestamp{Time: time.Now().UTC(), Valid: true}
	var res saveResult

	for i, row := range rows[1:] {
		line := i + 2
		for len(row) <= colMSRP {
			row = append(row, "")
		}
		vin := strings.TrimSpace(row[colVIN])
		if vin == "" {
			res.Skipped++
			continue
		}

		inserted, err := q.UpsertCar(ctx, database.UpsertCarParams{
			State:     strings.TrimSpace(row[colState]),
			City:      strings.TrimSpace(row[colCity]),
			Year:      strings.TrimSpace(row[colYear]),
			Make:      strings.TrimSpace(row[colMake]),
			Model:     strings.TrimSpace(row[colModel]),
			Trim:      strings.TrimSpace(row[colTrim]),
			Drive:     strings.TrimSpace(row[colDrive]),
			Vin:       vin,
			Color:     strings.TrimSpace(row[colColor]),
			Miles:     toInt32(row[colMiles]),
			Price:     toInt32(row[colPrice]),
			Msrp:      toInt32(row[colMSRP]), // "n/a" is stored as 0
			Timestamp: now,
		})
		if err != nil {
			respondErr(w, r, fmt.Errorf("row %d (VIN %s): %w", line, vin, err),
				fmt.Sprintf("database error on row %d (VIN %s); nothing was saved", line, vin))
			return
		}
		if inserted {
			res.Inserted++
		} else {
			res.Updated++
		}
	}

	if err := tx.Commit(ctx); err != nil {
		respondErr(w, r, err, "could not save to the database")
		return
	}
	if res.Skipped > 0 {
		res.Warnings = append(res.Warnings, fmt.Sprintf("%d rows had no VIN and were skipped", res.Skipped))
	}
	writeJSON(w, http.StatusOK, res)
}

func toInt32(s string) int32 {
	n, ok := excelutils.ParseMoney(s)
	if !ok || n > math.MaxInt32 || n < math.MinInt32 {
		return 0
	}
	return int32(n)
}
