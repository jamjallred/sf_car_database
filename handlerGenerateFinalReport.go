package main

import (
	"net/http"

	excelutils "github.com/jamjallred/sf_server_utils"
	"github.com/xuri/excelize/v2"
)

// POST /api/generate_final_report — multipart fields:
//
//	dibs:    dibs workbook (.xlsx)
//	initial: auction results (.csv)
func (cfg *apiConfig) handlerGenerateFinalReport(w http.ResponseWriter, r *http.Request) {
	if err := parseUploads(w, r); err != nil {
		respondErr(w, r, err, "")
		return
	}

	resultsFile, _, err := formFile(r, "initial", ".csv", "results CSV")
	if err != nil {
		respondErr(w, r, err, "")
		return
	}
	defer resultsFile.Close()

	dibsFile, _, err := formFile(r, "dibs", ".xlsx", "dibs sheet")
	if err != nil {
		respondErr(w, r, err, "")
		return
	}
	defer dibsFile.Close()

	records, err := readCSV(resultsFile)
	if err != nil {
		respondErr(w, r, err, "")
		return
	}

	dibs, err := excelize.OpenReader(dibsFile)
	if err != nil {
		respondErr(w, r, badRequest("the dibs sheet isn't a readable .xlsx workbook"), "")
		return
	}
	defer dibs.Close()

	if err := excelutils.GenerateFinalReport(records, dibs, cfg.team); err != nil {
		respondErr(w, r, err, "could not generate the final report")
		return
	}

	cfg.sendWorkbook(w, dibs, cfg.finalPrefix)
}
