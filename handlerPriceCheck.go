package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

// Price columns we recognise, best first. Per row, the first one with a
// value wins (so a CSV with an empty Buy It Now Price falls back to the
// Opening Price).
var priceColumnNames = []string{
	"sale price", "buy it now price", "price", "asking price", "internet price", "opening price",
}

// priceCheckRow is one car from the uploaded sheet.
type priceCheckRow struct {
	VIN        string `json:"vin"`
	Year       string `json:"year"`
	Make       string `json:"make"`
	Model      string `json:"model"`
	Trim       string `json:"trim"`
	City       string `json:"city"`
	State      string `json:"state"`
	Miles      int    `json:"miles"`
	SheetPrice int    `json:"sheetPrice"` // 0 = no price in the sheet
}

type priceCheckUpload struct {
	File        string          `json:"file"`
	Sheet       string          `json:"sheet,omitempty"`
	PriceColumn string          `json:"priceColumn"`
	Rows        []priceCheckRow `json:"rows"`
	Duplicates  int             `json:"duplicates"`
	NoVIN       int             `json:"noVin"`
}

// POST /api/price_check/upload — multipart field "file": .csv or .xlsx with
// a VIN column and a price column. Returns the cars as JSON.
func (cfg *apiConfig) handlerPriceCheckUpload(w http.ResponseWriter, r *http.Request) {
	if err := parseUploads(w, r); err != nil {
		respondErr(w, r, err, "")
		return
	}
	f, h, err := r.FormFile("file")
	if err != nil {
		respondErr(w, r, badRequest("missing the spreadsheet (.csv or .xlsx)"), "")
		return
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		respondErr(w, r, badRequest("could not read the upload"), "")
		return
	}

	var res priceCheckUpload
	switch strings.ToLower(filepath.Ext(h.Filename)) {
	case ".csv":
		res, err = parsePriceCheckCSV(data)
	case ".xlsx":
		res, err = parsePriceCheckXLSX(data)
	default:
		err = badRequest("%q isn't a .csv or .xlsx file", h.Filename)
	}
	if err != nil {
		respondErr(w, r, err, "could not read the spreadsheet")
		return
	}
	res.File = h.Filename
	writeJSON(w, http.StatusOK, res)
}

// GET /api/avis/status — progress of the Avis price download.
func (cfg *apiConfig) handlerAvisStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, cfg.avis.Status())
}

// POST /api/avis/refresh[?force=1] — start a download if the snapshot is
// missing or stale (or always, with force). Returns the status.
func (cfg *apiConfig) handlerAvisRefresh(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("force") == "1"
	writeJSON(w, http.StatusOK, cfg.avis.Refresh(force))
}

// POST /api/avis/lookup — body {"vins": [...]} → {"fetchedAt", "found": {vin: listing}}.
func (cfg *apiConfig) handlerAvisLookup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		VINs []string `json:"vins"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "expected JSON like {\"vins\": [\"…\"]}")
		return
	}
	found, fetchedAt, ok := cfg.avis.Lookup(req.VINs)
	if !ok {
		writeError(w, http.StatusConflict, "Avis prices haven't been downloaded yet")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"fetchedAt": fetchedAt.Format(time.RFC3339), "found": found})
}

// ---------- sheet parsing ----------

func parsePriceCheckCSV(data []byte) (priceCheckUpload, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")) // Excel's UTF-8 BOM
	rdr := csv.NewReader(bytes.NewReader(data))
	rdr.FieldsPerRecord = -1
	rdr.LazyQuotes = true
	records, err := rdr.ReadAll()
	if err != nil {
		return priceCheckUpload{}, badRequest("couldn't parse the CSV: %v", err)
	}
	res, ok := rowsFromRecords(records)
	if !ok {
		return priceCheckUpload{}, badRequest("couldn't find a VIN column and a price column (like \"Sale Price\" or \"Buy It Now Price\") in the CSV")
	}
	return res, nil
}

func parsePriceCheckXLSX(data []byte) (priceCheckUpload, error) {
	wb, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return priceCheckUpload{}, badRequest("that file isn't a readable .xlsx workbook")
	}
	defer wb.Close()

	// Use the first sheet that has both a VIN and a price column (the
	// comparison workbook starts with a Summary sheet).
	for _, name := range wb.GetSheetList() {
		records, err := wb.GetRows(name, excelize.Options{RawCellValue: true})
		if err != nil {
			continue
		}
		if res, ok := rowsFromRecords(records); ok {
			res.Sheet = name
			return res, nil
		}
	}
	return priceCheckUpload{}, badRequest("couldn't find a sheet with a VIN column and a price column (like \"Sale Price\" or \"Buy It Now Price\")")
}

// rowsFromRecords finds the header row (within the first 10 rows), maps the
// columns we know, and reads every car below it.
func rowsFromRecords(records [][]string) (priceCheckUpload, bool) {
	for h := 0; h < len(records) && h < 10; h++ {
		cols := map[string]int{}
		for i, name := range records[h] {
			key := strings.ToLower(strings.Join(strings.Fields(name), " "))
			if _, seen := cols[key]; !seen && key != "" {
				cols[key] = i
			}
		}
		vinCol, hasVIN := cols["vin"]
		var priceCols []int
		var priceName string
		for _, p := range priceColumnNames {
			if i, ok := cols[p]; ok {
				if priceName == "" {
					priceName = records[h][i]
				}
				priceCols = append(priceCols, i)
			}
		}
		if !hasVIN || len(priceCols) == 0 {
			continue
		}

		col := func(row []string, names ...string) string {
			for _, n := range names {
				if i, ok := cols[n]; ok && i < len(row) {
					return strings.TrimSpace(row[i])
				}
			}
			return ""
		}

		res := priceCheckUpload{PriceColumn: priceName, Rows: []priceCheckRow{}}
		seen := map[string]bool{}
		for _, row := range records[h+1:] {
			if vinCol >= len(row) {
				if strings.TrimSpace(strings.Join(row, "")) != "" {
					res.NoVIN++
				}
				continue
			}
			vin := normalizeVIN(row[vinCol])
			if vin == "" {
				if strings.TrimSpace(strings.Join(row, "")) != "" {
					res.NoVIN++
				}
				continue
			}
			if seen[vin] {
				res.Duplicates++
				continue
			}
			seen[vin] = true

			price := 0
			for _, i := range priceCols {
				if i < len(row) {
					if price = parseDollars(row[i]); price > 0 {
						break
					}
				}
			}
			miles := parseDollars(col(row, "mileage", "miles", "odometer"))
			res.Rows = append(res.Rows, priceCheckRow{
				VIN:        vin,
				Year:       col(row, "year"),
				Make:       col(row, "make"),
				Model:      col(row, "model"),
				Trim:       col(row, "trim"),
				City:       col(row, "city"),
				State:      col(row, "state"),
				Miles:      miles,
				SheetPrice: price,
			})
		}
		return res, true
	}
	return priceCheckUpload{}, false
}
