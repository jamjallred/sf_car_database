package main

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/xuri/excelize/v2"
)

type Car struct {
	State     string
	City      string
	Year      string
	Make      string
	Model     string
	Trim      string
	Drive     string
	VIN       string
	Color     string
	Miles     int
	Price     int
	MSRP      int
	Timestamp time.Time
}

func (cfg *apiConfig) handlerSaveToDB(w http.ResponseWriter, r *http.Request) {

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	f, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		http.Error(w, "Failed to parse excel file", http.StatusBadRequest)
		return
	}
	defer f.Close()

	sheetName := f.GetSheetName(0)

	rows, err := f.GetRows(sheetName)
	if err != nil {
		http.Error(w, "Failed to read sheet", http.StatusBadRequest)
		return
	}

	timestamp := time.Now()
	var cars []Car

	for i, row := range rows {
		if i == 0 {
			continue
		}

		for len(row) < 12 {
			row = append(row, "")
		}

		miles, _ := strconv.Atoi(row[9])
		price, _ := strconv.Atoi(row[10])
		msrp, _ := strconv.Atoi(row[11])

		cars = append(cars, Car{
			State:     row[0],
			City:      row[1],
			Year:      row[2],
			Make:      row[3],
			Model:     row[4],
			Trim:      row[5],
			Drive:     row[6],
			VIN:       row[7],
			Color:     row[8],
			Miles:     miles,
			Price:     price,
			MSRP:      msrp,
			Timestamp: timestamp,
		})

	}

}
