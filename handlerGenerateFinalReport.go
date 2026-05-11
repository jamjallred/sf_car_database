package main

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	excelutils "github.com/jamjallred/sf_server_utils"
	"github.com/joho/godotenv"
	"github.com/xuri/excelize/v2"
)

func (cfg apiConfig) handlerGenerateFinalReport(w http.ResponseWriter, r *http.Request) {

	godotenv.Load()

	err := r.ParseMultipartForm(32 << 20)
	if err != nil {
		http.Error(w, "Upload too large", http.StatusBadRequest)
		return
	}

	csvFile, csvHeader, err := r.FormFile("initial")
	if err != nil {
		http.Error(w, "missing initial csv file", http.StatusBadRequest)
		return
	}
	defer csvFile.Close()
	fmt.Printf("Received CSV: %s\n", csvHeader.Filename)

	xlsxFile, xlsxHeader, err := r.FormFile("dibs")
	if err == nil {
		http.Error(w, "missing dibs xlsx file", http.StatusBadRequest)
	}
	defer xlsxFile.Close()
	fmt.Printf("Received XLSX: %s\n", xlsxHeader.Filename)

	if !strings.HasSuffix(strings.ToLower(csvHeader.Filename), ".csv") {
		http.Error(w, "only .csv files allowed for dibs upload", http.StatusBadRequest)
		return
	}

	if !strings.HasSuffix(strings.ToLower(xlsxHeader.Filename), ".xlsx") {
		http.Error(w, "only .xlsx file allowed for initial results upload", http.StatusBadRequest)
	}

	rdr := csv.NewReader(csvFile)
	csvRecords, err := rdr.ReadAll()
	if err != nil {
		http.Error(w, "invalid csv", http.StatusBadRequest)
		return
	}

	xlsxRecords, err := excelize.OpenReader(xlsxFile)
	if err != nil {
		http.Error(w, "invalid xlsx", http.StatusBadRequest)
		return
	}

	savePath := "/home/fleetdbadmin/workspace/github.com/jamjallred/sf_car_database/assets/" + os.Getenv("FILENAME_PREFIX_FINAL_REPORT") + time.Now().Format("2006-01-02") + ".xlsx"
	err = excelutils.GenerateFinalReport(csvRecords, xlsxRecords, savePath)
	if err != nil {
		fmt.Printf("error generating final report: %v", err)
		http.Error(w, "error generating final report", http.StatusInternalServerError)
	}

}
