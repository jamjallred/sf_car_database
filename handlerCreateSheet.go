package main

import (
	"encoding/gob"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

type CityState struct {
	City  string
	State string
}

var mapFilePath = "assets/airport_code_map.gob"
var newFilePath = "test.xlsx"
var templateFilePath = "assets/nationwide_template.xlsx"

func handlerCreateSheet(w http.ResponseWriter, r *http.Request) {

	if _, err := os.Stat(mapFilePath); err != nil {
		fmt.Println("No map found. Creating airport map...")
		createAirportMap()
	}

	airport_code_map := make(map[string]CityState)
	mapfile, err := os.Open(mapFilePath)
	if err != nil {
		fmt.Println("error opening map file:", err)
		reportServerError(w)
		return
	}
	defer mapfile.Close()

	decoder := gob.NewDecoder(mapfile)
	if err = decoder.Decode(&airport_code_map); err != nil {
		fmt.Println("error decoding map:", err)
		reportServerError(w)
		return
	}

	if err = copyTemplate(templateFilePath, newFilePath); err != nil {
		fmt.Println("error copying template:", err)
		return
	}

	dst, err := excelize.OpenFile(newFilePath)
	if err != nil {
		fmt.Println("error opening new excel file:", err)
		reportServerError(w)
		return
	}
	defer dst.Close()

	// THIS NEEDS TO BE CHANGED TO READ JSON PAYLOAD FROM REQUEST
	src, err := excelize.OpenFile("In-Service Inventory D2D 12.8.25.xlsx")
	if err != nil {
		fmt.Println(err)
		return
	}
	defer src.Close()

	generateSheet(dst, src, airport_code_map)

}

func generateSheet(dst, src *excelize.File, airport_code_map map[string]CityState) error {

	// newHeaders := []string{"State", "City", "Yr", "Make", "Model", "Trim", "Drive", "Vin", "Color", "Miles", "Price", "MSRP", "Notes", "Notes2"}
	dst.SetCellValue("Sheet1", "G1", "Drive")                    // rename "Body Type" to "Drive"
	colIndices := []int{5, 9, 10, 11, 12, 18, 8, 17, 13, 20, 19} // column order from source sheet

	srcRows, err := src.GetRows("Sheet1")
	if err != nil {
		fmt.Println(err)
		return err
	}

	adjust := 0 // to adjust for skipped rows due to missing airport codes
	rowNum := 0 // scope to outside loop block to use for style formatting

	fmt.Println("Generating sheet...")

	for i, row := range srcRows[3:] { // skipping date, empty line, header rows
		val, ok := airport_code_map[row[colIndices[0]]]
		if !ok {
			adjust += 1
			continue
		}
		rowData := make([]interface{}, 0, len(colIndices))
		rowData = append(rowData, val.State, val.City)

		for _, colIdx := range colIndices[1:] {
			rowData = append(rowData, row[colIdx])
		}

		rowNum = i + 2 - adjust // A2 is first row after header
		rowRef := fmt.Sprintf("A%v", rowNum)
		if err = dst.SetSheetRow("Sheet1", rowRef, &rowData); err != nil {
			fmt.Println("error setting row:", err)
			return err
		}

		// check if MSRP is sane, if not, set to n/a
		msrpStr, err := dst.GetCellValue("Sheet1", fmt.Sprintf("L%v", rowNum))
		if err != nil {
			fmt.Println("error getting MSRP cell value:", err)
			return err
		}

		msrpStr = strings.TrimSpace(msrpStr)
		if len(msrpStr) <= 6 {
			dst.SetCellValue("Sheet1", fmt.Sprintf("L%v", rowNum), "n/a")
		}

	}

	//sort row data by State, City, Yr, Make, then Model
	fmt.Println("Sorting sheet...")
	srcRows = nil // free up memory
	dstRows, err := dst.GetRows("Sheet1")
	if err != nil {
		fmt.Println(err)
		return err
	}

	slices.SortFunc(dstRows[1:], func(a, b []string) int {
		if n := strings.Compare(a[0], b[0]); n != 0 { // compare state
			return n
		}
		if n := strings.Compare(a[1], b[1]); n != 0 { // compare city
			return n
		}
		if n := strings.Compare(a[2], b[2]); n != 0 { // compare year
			return n
		}
		if n := strings.Compare(a[3], b[3]); n != 0 { // compare make
			return n
		}
		return strings.Compare(a[4], b[4]) // compare model
	})

	// write sorted data into sheet
	for i, row := range dstRows[1:] { // skip header row
		rowNum = i + 2
		rowRef := fmt.Sprintf("A%v", rowNum)
		year, _ := strconv.Atoi(strings.TrimSpace(row[2]))
		miles, _ := strconv.Atoi(strings.TrimSpace(row[9]))
		price, _ := strconv.Atoi(strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(row[10], "$", ""), ",", "")))
		msrp, _ := strconv.Atoi(strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(row[11], "$", ""), ",", "")))
		rowData := make([]interface{}, 0, len(row))
		rowData = append(rowData, row[0], row[1], year, row[3], row[4], row[5], row[6], row[7], row[8], miles, price, msrp)

		if err = dst.SetSheetRow("Sheet1", rowRef, &rowData); err != nil {
			fmt.Println("error setting sorted row:", err)
			return err
		}
	}

	// convert Yr, Miles, Price, MSRP to Number style, skip header row
	fmt.Println("Converting Number Cells...")
	decimalPlaces := 0
	numID, err := dst.NewStyle(&excelize.Style{
		NumFmt: 1, // number format with no decimals
		Font: &excelize.Font{
			Family: "Calibri",
			Size:   10,
		},
	})
	if err != nil {
		fmt.Println("error creating style:", err)
		return err
	}
	currencyID, err := dst.NewStyle(&excelize.Style{
		NumFmt:        177, // US Dollar format
		DecimalPlaces: &decimalPlaces,
		Font: &excelize.Font{
			Family: "Calibri",
			Size:   10,
		},
	})
	if err != nil {
		fmt.Println("error creating style:", err)
		return err
	}
	dst.SetCellStyle("Sheet1", "C2", fmt.Sprintf("C%v", rowNum), numID)
	dst.SetCellStyle("Sheet1", "J2", fmt.Sprintf("J%v", rowNum), numID)
	dst.SetCellStyle("Sheet1", "K2", fmt.Sprintf("L%v", rowNum), currencyID)

	// CONSIDER UPDATING THIS TO NOT SAVE NEW FILE TO DISK (MIGHT BE GOOD IDEA TO SAVE THO IDK)
	//save file
	fmt.Println("Saving file...")
	if err = dst.SaveAs("test.xlsx"); err != nil {
		log.Fatalf("error saving file: %v", err)
	}

	fmt.Println("Sheet generated successfully.")

	return nil

}

func createAirportMap() error {

	f, err := excelize.OpenFile("assets/Airport_Codes.xlsx")
	if err != nil {
		fmt.Println(err)
		return err
	}
	defer f.Close()

	mapfile, err := os.Create("assets/airport_code_map.gob")
	if err != nil {
		fmt.Println("error creating map file:", err)
		return err
	}
	defer mapfile.Close()

	airport_code_map := make(map[string]CityState)

	rows, err := f.GetRows("Sheet1")
	if err != nil {
		fmt.Println(err)
		return err
	}

	for i, row := range rows {
		if i == 0 {
			continue // skip header
		}
		airport_code_map[row[1]] = CityState{City: row[2], State: row[3]}
	}

	encoder := gob.NewEncoder(mapfile)
	if err = encoder.Encode(airport_code_map); err != nil {
		fmt.Println("error encoding map:", err)
		return err
	}

	fmt.Println("Airport code map created successfully.")

	return nil

}

func copyTemplate(templateFilePath, newFilePath string) error {

	template, err := os.Open(templateFilePath)
	if err != nil {
		fmt.Println("error opening template file:", err)
		return err
	}
	defer template.Close()

	newFile, err := os.Create(newFilePath)
	if err != nil {
		fmt.Println("error creating new file:", err)
		return err
	}
	defer newFile.Close()

	_, err = io.Copy(newFile, template)
	if err != nil {
		fmt.Println("error copying template to new file:", err)
		return err
	}

	err = newFile.Sync()
	if err != nil {
		fmt.Println("error syncing file to disk:", err)
		return err
	}

	return nil

}

func reportServerError(w http.ResponseWriter) {
	w.WriteHeader(http.StatusInternalServerError)
	w.Write([]byte("Internal Server Error"))
}
