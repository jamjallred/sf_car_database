package main

import (
	"fmt"
	"net/http"

	excelutils "github.com/jamjallred/sf_server_utils"
)

// POST /api/create_sheet — in-service inventory export (.xlsx), either as
// multipart field "file" or as the raw request body.
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

	w.Header().Set("X-Sheet-Summary", fmt.Sprintf(
		"%d cars, %d duplicate VINs skipped, %d unknown airport codes", res.Rows, res.Duplicates, res.UnknownCodes))
	cfg.sendWorkbook(w, res.File, cfg.nationwidePrefix)
}
