package main

import (
	"encoding/csv"
	"net/http"

	excelutils "github.com/jamjallred/sf_server_utils"
)

// POST /api/generate_grounded — multipart field "file": grounded inventory CSV.
func (cfg *apiConfig) handlerGenerateGrounded(w http.ResponseWriter, r *http.Request) {
	if err := parseUploads(w, r); err != nil {
		respondErr(w, r, err, "")
		return
	}

	file, _, err := formFile(r, "file", ".csv", "inventory CSV")
	if err != nil {
		respondErr(w, r, err, "")
		return
	}
	defer file.Close()

	records, err := readCSV(file)
	if err != nil {
		respondErr(w, r, err, "")
		return
	}

	wb, err := excelutils.GenerateGrounded(r.Context(), records, cfg)
	if err != nil {
		respondErr(w, r, err, "could not generate the grounded sheet")
		return
	}
	defer wb.Close()

	cfg.sendWorkbook(w, wb, cfg.groundedPrefix)
}

func readCSV(f interface{ Read([]byte) (int, error) }) ([][]string, error) {
	rdr := csv.NewReader(f)
	rdr.FieldsPerRecord = -1 // tolerate ragged rows
	rdr.LazyQuotes = true
	records, err := rdr.ReadAll()
	if err != nil {
		return nil, badRequest("couldn't parse the CSV: %v", err)
	}
	return records, nil
}
