package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"

	excelutils "github.com/jamjallred/sf_server_utils"
)

// POST /api/create_sheet — in-service inventory export (.xlsx), either as
// multipart field "file" or as the raw request body. The nationwide sheet is
// saved to the database (as /api/saveToDB would) and then downloaded.
func (cfg *apiConfig) handlerCreateSheet(w http.ResponseWriter, r *http.Request) {
	src, err := readWorkbookUpload(w, r)
	if err != nil {
		respondErr(w, r, err, "")
		return
	}
	defer src.Close()

	res, err := excelutils.GenerateInService(src)
	if err != nil {
		respondErr(w, r, err, "could not generate the nationwide sheet")
		return
	}
	defer res.File.Close()

	summary := fmt.Sprintf("%s, %s skipped, %s",
		plural(res.Rows, "car", "cars"), plural(res.Duplicates, "duplicate VIN", "duplicate VINs"),
		plural(res.UnknownCodes, "unknown airport code", "unknown airport codes"))

	// Save the new sheet to the database straight away. If that fails the
	// sheet is still sent, with the reason in X-Save-Error for the page to show.
	saved, err := cfg.saveNationwide(r.Context(), res.File, res)
	if err != nil {
		log.Printf("%s %s: saving to database: %v", r.Method, r.URL.Path, err)
		msg := "its cars were NOT saved to the database"
		var ce *clientError
		if errors.As(err, &ce) {
			msg += ": " + ce.msg
		}
		w.Header().Set("X-Save-Error", msg)
	} else {
		summary += fmt.Sprintf("; saved to the database: %d new, %d updated", saved.Inserted, saved.Updated)
		if saved.Skipped > 0 {
			summary += fmt.Sprintf(", %s without a VIN skipped", plural(saved.Skipped, "row", "rows"))
		}
		if saved.Unmapped > 0 {
			summary += fmt.Sprintf("; %s with unknown airport codes kept aside for review",
				plural(saved.Unmapped, "car", "cars"))
		}
	}
	w.Header().Set("X-Sheet-Summary", summary)
	cfg.sendWorkbook(w, res.File, cfg.nationwidePrefix)
}

// plural formats a count with the right noun, e.g. "1 car" or "3 cars".
func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
