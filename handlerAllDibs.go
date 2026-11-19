package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"time"
	_ "time/tzdata" // so ?tz= works even without the system zone database

	"github.com/xuri/excelize/v2"
)

type allDibsJSON struct {
	Cars      []carJSON   `json:"cars"`
	DibsNames []string    `json:"dibsNames"`
	WaveName  string      `json:"waveName"`
	Latest    *importJSON `json:"latest,omitempty"` // nil: no import yet, so every car counts
}

// dibbedCars returns the cars on the latest nationwide sheet that have at
// least one active dibs, with their dibs and notes.
func (cfg *apiConfig) dibbedCars(ctx context.Context) (allDibsJSON, error) {
	out := allDibsJSON{Cars: []carJSON{}, DibsNames: dibsNames, WaveName: waveName}
	latest, err := cfg.latestImport(ctx)
	if err != nil {
		return out, err
	}
	out.Latest = latest
	var importID *int64
	if latest != nil {
		importID = &latest.ID
	}
	cars, err := cfg.dbQueries.ListDibbedCars(ctx, importID)
	if err != nil {
		return out, err
	}
	vins := make([]string, len(cars))
	for i, c := range cars {
		vins[i] = c.Vin
	}
	dibs, err := cfg.dibsFor(ctx, cfg.dbQueries, vins)
	if err != nil {
		return out, err
	}
	notes, err := notesFor(ctx, cfg.dbQueries, vins)
	if err != nil {
		return out, err
	}
	waves, err := waveFor(ctx, cfg.dbQueries, vins)
	if err != nil {
		return out, err
	}
	for _, c := range cars {
		cj := toCarJSON(c, dibs[c.Vin], notes[c.Vin], latest)
		cj.Wave = waves[c.Vin]
		out.Cars = append(out.Cars, cj)
	}
	return out, nil
}

// GET /api/dibs/all — every car on the latest nationwide sheet with an
// active dibs, in the same shape as /api/cars.
func (cfg *apiConfig) handlerAllDibs(w http.ResponseWriter, r *http.Request) {
	res, err := cfg.dibbedCars(r.Context())
	if err != nil {
		respondErr(w, r, err, "could not load dibs")
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// GET /api/dibs/all.xlsx?tz=America/Chicago — the same cars as a workbook:
// the nationwide sheet's columns, then each person's dibs (TRUE/FALSE, with
// claimed cells coloured by order) and notes. tz sets the date in the filename.
func (cfg *apiConfig) handlerAllDibsXLSX(w http.ResponseWriter, r *http.Request) {
	loc := time.Local
	if tz := r.URL.Query().Get("tz"); tz != "" {
		if l, err := time.LoadLocation(tz); err == nil {
			loc = l
		}
	}
	res, err := cfg.dibbedCars(r.Context())
	if err != nil {
		respondErr(w, r, err, "could not load dibs")
		return
	}
	wb, err := allDibsWorkbook(res)
	if err != nil {
		respondErr(w, r, err, "could not build the spreadsheet")
		return
	}
	defer wb.Close()
	var buf bytes.Buffer
	if err := wb.Write(&buf); err != nil {
		respondErr(w, r, err, "could not build the spreadsheet")
		return
	}
	sendXLSX(w, buf.Bytes(), "all_dibs_"+time.Now().In(loc).Format("2006-01-02")+".xlsx")
}

// Dibs fills by order called, matching the inventory page: green, blue,
// yellow, orange (the 5th and later stay orange).
var dibFills = []string{"#B7E4C0", "#BCD8FB", "#FBE98A", "#FDC58A"}

// waveFill marks a ticked 2nd Wave cell, matching the page's purple.
const waveFill = "#DDD2FA"

func allDibsWorkbook(res allDibsJSON) (*excelize.File, error) {
	f := excelize.NewFile()
	const sheet = "All Dibs"
	if err := f.SetSheetName("Sheet1", sheet); err != nil {
		return nil, err
	}

	header := []any{"State", "City", "Yr", "Make", "Model", "Trim", "Drive", "Vin", "Color", "Miles", "Price", "MSRP"}
	widths := []float64{7, 16, 6, 12, 22, 22, 7, 20, 11, 9, 10, 10}
	header = append(header, res.WaveName) // after MSRP, as on the page
	widths = append(widths, 10)
	waveCol, _ := excelize.ColumnNumberToName(len(header))
	carCols := len(header) // the dibs columns start after these
	for _, n := range res.DibsNames {
		header = append(header, n)
		widths = append(widths, 10)
	}
	for _, n := range res.DibsNames {
		header = append(header, n+" Notes")
		widths = append(widths, 30)
	}

	font := &excelize.Font{Family: "Calibri", Size: 10}
	headStyle, err := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Family: "Calibri", Size: 10, Bold: true},
		Fill: excelize.Fill{Type: "pattern", Color: []string{"#F0F2F5"}, Pattern: 1},
	})
	if err != nil {
		return nil, err
	}
	textStyle, _ := f.NewStyle(&excelize.Style{Font: font})
	yearStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 1, Font: font})   // 0
	numberStyle, _ := f.NewStyle(&excelize.Style{NumFmt: 3, Font: font}) // #,##0
	zero := 0
	moneyStyle, err := f.NewStyle(&excelize.Style{NumFmt: 177, DecimalPlaces: &zero, Font: font})
	if err != nil {
		return nil, err
	}
	center := &excelize.Alignment{Horizontal: "center"}
	noDibStyle, err := f.NewStyle(&excelize.Style{Font: font, Alignment: center})
	if err != nil {
		return nil, err
	}
	waveFillStyle, err := f.NewStyle(&excelize.Style{
		Font: font, Alignment: center, Fill: excelize.Fill{Type: "pattern", Color: []string{waveFill}, Pattern: 1},
	})
	if err != nil {
		return nil, err
	}
	fillStyles := make([]int, len(dibFills))
	for i, c := range dibFills {
		if fillStyles[i], err = f.NewStyle(&excelize.Style{
			Font: font, Alignment: center, Fill: excelize.Fill{Type: "pattern", Color: []string{c}, Pattern: 1},
		}); err != nil {
			return nil, err
		}
	}

	if err := f.SetSheetRow(sheet, "A1", &header); err != nil {
		return nil, err
	}
	lastCol, _ := excelize.ColumnNumberToName(len(header))
	if err := f.SetCellStyle(sheet, "A1", lastCol+"1", headStyle); err != nil {
		return nil, err
	}
	for i, wd := range widths {
		col, _ := excelize.ColumnNumberToName(i + 1)
		if err := f.SetColWidth(sheet, col, col, wd); err != nil {
			return nil, err
		}
	}

	for i, c := range res.Cars {
		row := i + 2
		msrp := any(c.MSRP)
		if c.MSRP == 0 {
			msrp = "n/a"
		}
		price := any(c.Price)
		if c.Price == 0 {
			price = "n/a"
		}
		values := []any{c.State, c.City, yearValue(c.Year), c.Make, c.Model, c.Trim, c.Drive, c.VIN, c.Color, c.Miles, price, msrp, c.Wave != nil}
		order := make(map[string]int, len(c.Dibs))
		for j, d := range c.Dibs {
			order[d.Name] = j
		}
		for _, n := range res.DibsNames {
			_, ok := order[n]
			values = append(values, ok) // TRUE when this person has dibs
		}
		for _, n := range res.DibsNames {
			values = append(values, c.Notes[n])
		}
		cell := fmt.Sprintf("A%d", row)
		if err := f.SetSheetRow(sheet, cell, &values); err != nil {
			return nil, fmt.Errorf("writing row %d: %w", row, err)
		}
		if err := f.SetCellStyle(sheet, cell, fmt.Sprintf("%s%d", lastCol, row), textStyle); err != nil {
			return nil, err
		}
		for _, s := range []struct {
			from, to string
			style    int
		}{{"C", "C", yearStyle}, {"J", "J", numberStyle}, {"K", "L", moneyStyle}} {
			if err := f.SetCellStyle(sheet, fmt.Sprintf("%s%d", s.from, row), fmt.Sprintf("%s%d", s.to, row), s.style); err != nil {
				return nil, err
			}
		}
		waveStyle := noDibStyle
		if c.Wave != nil {
			waveStyle = waveFillStyle
		}
		if ref := fmt.Sprintf("%s%d", waveCol, row); f.SetCellStyle(sheet, ref, ref, waveStyle) != nil {
			return nil, fmt.Errorf("styling %s", ref)
		}
		for k, n := range res.DibsNames {
			style := noDibStyle
			if j, ok := order[n]; ok {
				style = fillStyles[min(j, len(fillStyles)-1)]
			}
			col, _ := excelize.ColumnNumberToName(carCols + k + 1)
			ref := fmt.Sprintf("%s%d", col, row)
			if err := f.SetCellStyle(sheet, ref, ref, style); err != nil {
				return nil, err
			}
		}
	}

	if err := f.SetPanes(sheet, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"}); err != nil {
		return nil, err
	}
	if len(res.Cars) > 0 {
		if err := f.AutoFilter(sheet, fmt.Sprintf("A1:%s%d", lastCol, len(res.Cars)+1), nil); err != nil {
			return nil, err
		}
	}
	return f, nil
}

// yearValue writes a numeric model year as a number, like the nationwide sheet.
func yearValue(y string) any {
	var n int
	if _, err := fmt.Sscanf(y, "%d", &n); err == nil && fmt.Sprint(n) == y {
		return n
	}
	return y
}
