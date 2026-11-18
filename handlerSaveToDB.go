package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jamjallred/sf_car_database/internal/database"
	excelutils "github.com/jamjallred/sf_server_utils"
	"github.com/xuri/excelize/v2"
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
	ImportID int64    `json:"importId"`
	Inserted int      `json:"inserted"`
	Updated  int      `json:"updated"`
	Skipped  int      `json:"skipped"`
	Unmapped int      `json:"unmapped"` // cars saved to unmapped_cars
	Warnings []string `json:"warnings,omitempty"`
}

// POST /api/saveToDB — a nationwide sheet (.xlsx), as multipart field "file"
// or raw body. Cars are upserted by VIN in a single transaction. The
// Nationwide page no longer calls this (generating a sheet saves it), but it's
// kept for re-saving an existing sheet.
func (cfg *apiConfig) handlerSaveToDB(w http.ResponseWriter, r *http.Request) {
	wb, err := readWorkbookUpload(w, r)
	if err != nil {
		respondErr(w, r, err, "")
		return
	}
	defer wb.Close()

	res, err := cfg.saveNationwide(r.Context(), wb, nil)
	if err != nil {
		respondErr(w, r, err, "could not save to the database; nothing was saved")
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// saveNationwide records a new import and, in one transaction, upserts every
// row of a nationwide sheet's first sheet by VIN (tagging each car with the
// import) and, when src is given, saves the in-service rows left off the sheet
// for unknown airport codes to unmapped_cars. Problems with the sheet come
// back as clientErrors.
func (cfg *apiConfig) saveNationwide(ctx context.Context, wb *excelize.File, src *excelutils.InServiceResult) (saveResult, error) {
	var res saveResult
	rows, err := wb.GetRows(wb.GetSheetName(0))
	if err != nil {
		return res, badRequest("couldn't read the first sheet")
	}
	if len(rows) < 2 {
		return res, badRequest("the sheet has no data rows")
	}

	tx, err := cfg.db.Begin(ctx)
	if err != nil {
		return res, fmt.Errorf("starting transaction: %w", err)
	}
	defer tx.Rollback(ctx) // no-op after Commit
	q := cfg.dbQueries.WithTx(tx)

	now := pgtype.Timestamp{Time: time.Now().UTC(), Valid: true}
	importID, err := q.CreateImport(ctx, now)
	if err != nil {
		return res, fmt.Errorf("recording the import: %w", err)
	}
	res.ImportID = importID

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
			State:        strings.TrimSpace(row[colState]),
			City:         strings.TrimSpace(row[colCity]),
			Year:         strings.TrimSpace(row[colYear]),
			Make:         strings.TrimSpace(row[colMake]),
			Model:        strings.TrimSpace(row[colModel]),
			Trim:         strings.TrimSpace(row[colTrim]),
			Drive:        strings.TrimSpace(row[colDrive]),
			Vin:          vin,
			Color:        strings.TrimSpace(row[colColor]),
			Miles:        toInt32(row[colMiles]),
			Price:        toInt32(row[colPrice]),
			Msrp:         toInt32(row[colMSRP]), // "n/a" is stored as 0
			Timestamp:    now,
			LastImportID: &importID,
		})
		if err != nil {
			return saveResult{}, fmt.Errorf("row %d (VIN %s): %w", line, vin, err)
		}
		if inserted {
			res.Inserted++
		} else {
			res.Updated++
		}
	}

	if src != nil {
		for _, u := range src.Unmapped {
			vin := strings.TrimSpace(u.VIN)
			if vin == "" {
				res.Skipped++
				continue
			}
			raw, fields := inServiceRow(src.Header, u.Row)
			if err := q.UpsertUnmappedCar(ctx, database.UpsertUnmappedCarParams{
				Vin: vin, AirportCode: strings.TrimSpace(u.Code), Fields: fields, Raw: raw,
				ImportID: importID, FirstSeen: now,
			}); err != nil {
				return saveResult{}, fmt.Errorf("unmapped car %s: %w", vin, err)
			}
			res.Unmapped++
		}
	}

	if err := q.FinishImport(ctx, database.FinishImportParams{
		ID: importID, Cars: int32(res.Inserted + res.Updated), Unmapped: int32(res.Unmapped),
	}); err != nil {
		return saveResult{}, fmt.Errorf("finishing the import: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return saveResult{}, fmt.Errorf("committing: %w", err)
	}
	if res.Skipped > 0 {
		res.Warnings = append(res.Warnings, fmt.Sprintf("%d rows had no VIN and were skipped", res.Skipped))
	}
	return res, nil
}

// inServiceRow returns an in-service row padded to the header's width, and
// the same values as a JSON object keyed by header ("Column N" for a blank
// header, "Name (2)" for a repeated one).
func inServiceRow(header, row []string) ([]string, []byte) {
	n := max(len(header), len(row))
	raw := make([]string, n)
	copy(raw, row)
	fields := make(map[string]string, n)
	for i := range n {
		name := ""
		if i < len(header) {
			name = strings.TrimSpace(header[i])
		}
		if name == "" {
			name = fmt.Sprintf("Column %d", i+1)
		}
		key := name
		for k := 2; ; k++ {
			if _, taken := fields[key]; !taken {
				break
			}
			key = fmt.Sprintf("%s (%d)", name, k)
		}
		fields[key] = raw[i]
	}
	b, _ := json.Marshal(fields) // a map of strings always marshals
	return raw, b
}

func toInt32(s string) int32 {
	n, ok := excelutils.ParseMoney(s)
	if !ok || n > math.MaxInt32 || n < math.MinInt32 {
		return 0
	}
	return int32(n)
}
