package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

func TestParseDollars(t *testing.T) {
	cases := map[string]int{"$18,199": 18199, "18199": 18199, "18199.6": 18200, "": 0, "Call": 0, " $1,611 ": 1611}
	for in, want := range cases {
		if got := parseDollars(in); got != want {
			t.Errorf("parseDollars(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseRobots(t *testing.T) {
	txt := `
User-agent: GPTBot
Disallow: /api/

User-agent: *
Disallow: /api/pse/
Disallow: /*ajax.htm$
Crawl-delay: 10

User-agent: Baiduspider
Disallow: /
`
	rules, delay := parseRobots([]byte(txt))
	if delay != 10*time.Second {
		t.Errorf("crawl delay = %v, want 10s", delay)
	}
	for path, want := range map[string]bool{
		avisInventoryAPI:    true,
		avisInventoryPage:   true,
		"/api/pse/x":        false,
		"/foo/ajax.htm":     false,
		"/foo/ajax.htm?x=1": true,
	} {
		if got := rules.allowed(path); got != want {
			t.Errorf("allowed(%q) = %v, want %v", path, got, want)
		}
	}
}

func invItem(vin, asking string) map[string]any {
	return map[string]any{
		"vin":   vin,
		"link":  "/used/Jeep/2025-Jeep-Compass-" + vin + ".htm",
		"title": []string{"2025 Jeep", "Compass Latitude"},
		"pricing": map[string]any{"dprice": []map[string]any{
			{"typeClass": "wholesalePrice", "value": "$19,810"},
			{"typeClass": "askingPrice", "value": asking},
			{"typeClass": "priceAfterFees", "value": "$99,999"},
		}},
		"trackingPricing": map[string]any{"salePrice": "1"},
	}
}

func TestDownloadPagesThroughInventory(t *testing.T) {
	const total = 5
	var apiCalls atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "User-agent: *\nDisallow: /api/pse/\n")
	})
	mux.HandleFunc(avisInventoryPage, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<script>{"pageId":"avisbudgetgroupcarsales_TEST_AUTO_USED_V1"}</script>`)
	})
	mux.HandleFunc(avisInventoryAPI, func(w http.ResponseWriter, r *http.Request) {
		apiCalls.Add(1)
		var body struct {
			PageID string              `json:"pageId"`
			Params map[string][]string `json:"inventoryParameters"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.PageID != "avisbudgetgroupcarsales_TEST_AUTO_USED_V1" {
			t.Errorf("pageId = %q", body.PageID)
		}
		start := 0
		if s := body.Params["start"]; len(s) == 1 {
			fmt.Sscan(s[0], &start)
		}
		items := []map[string]any{}
		for i := start; i < total && i < start+2; i++ {
			items = append(items, invItem(fmt.Sprintf("vin%014d", i), fmt.Sprintf("$%d,000", 10+i)))
		}
		json.NewEncoder(w).Encode(map[string]any{"pageInfo": map[string]int{"totalCount": total, "pageSize": 2}, "inventory": items})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newAvisClient(srv.URL, "test", time.Millisecond, time.Hour)
	var slept time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { slept += d; return nil }

	listings, err := c.download(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(listings) != total || apiCalls.Load() != 3 {
		t.Fatalf("got %d listings in %d calls, want %d in 3", len(listings), apiCalls.Load(), total)
	}
	l := listings["VIN00000000000003"]
	if l.Price != 13000 || l.Title != "2025 Jeep Compass Latitude" || l.Link != "https://www.aviscarsales.com/used/Jeep/2025-Jeep-Compass-vin00000000000003.htm" {
		t.Errorf("listing = %+v", l)
	}
	if c.pagesTotal != 3 || c.pagesDone != 3 {
		t.Errorf("progress %d/%d, want 3/3", c.pagesDone, c.pagesTotal)
	}
	if slept < 4*time.Millisecond { // before the page fetch and each API call
		t.Errorf("slept only %v; requests weren't spaced out", slept)
	}
}

func TestDownloadRefusesWhenRobotsDisallows(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/robots.txt", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "User-agent: *\nDisallow: /api/\n")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request to %s", r.URL.Path)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	c := newAvisClient(srv.URL, "test", time.Millisecond, time.Hour)
	c.sleep = func(context.Context, time.Duration) error { return nil }
	if _, err := c.download(context.Background()); err == nil {
		t.Fatal("expected an error")
	}
}

func TestParsePriceCheckCSV(t *testing.T) {
	csvData := "\xef\xbb\xbfVIN,Year,Make,Model,Trim,Mileage,Opening Price,Buy It Now Price,City,State\n" +
		"1gazgpfp8s1216328,2025,Chevrolet,Express,LT,28277,35300,35300,Sumner,WA\n" +
		"3GNKBCR49SS196257,2025,Chevrolet,Blazer,LT,41853,18600,,East Windsor,CT\n" +
		"1GAZGPFP8S1216328,2025,Chevrolet,Express,LT,28277,35300,35300,Sumner,WA\n" +
		",,,,,,,,,\n"
	res, err := parsePriceCheckCSV([]byte(csvData))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rows) != 2 || res.Duplicates != 1 || res.PriceColumn != "Buy It Now Price" {
		t.Fatalf("got %+v", res)
	}
	if r := res.Rows[0]; r.VIN != "1GAZGPFP8S1216328" || r.SheetPrice != 35300 || r.Miles != 28277 || r.City != "Sumner" {
		t.Errorf("row 0 = %+v", r)
	}
	if res.Rows[1].SheetPrice != 18600 { // falls back to Opening Price
		t.Errorf("row 1 price = %d, want 18600", res.Rows[1].SheetPrice)
	}
}

func TestParsePriceCheckXLSXSkipsSummarySheet(t *testing.T) {
	wb := excelize.NewFile()
	wb.SetSheetName("Sheet1", "Summary")
	wb.SetSheetRow("Summary", "A1", &[]any{"Metric", "Count"})
	wb.NewSheet("Daily Export Comparison")
	wb.SetSheetRow("Daily Export Comparison", "A1", &[]any{"State", "City", "VIN", "Year", "Make", "Model", "Miles", "Sale Price", "Previous Price"})
	wb.SetSheetRow("Daily Export Comparison", "A2", &[]any{"CA", "Colton", "3C4NJDBN5ST547225", 2025, "Jeep", "Compass", 36509, 18100, 18300})
	var buf bytes.Buffer
	wb.Write(&buf)

	res, err := parsePriceCheckXLSX(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if res.Sheet != "Daily Export Comparison" || len(res.Rows) != 1 {
		t.Fatalf("got %+v", res)
	}
	if r := res.Rows[0]; r.SheetPrice != 18100 || r.Year != "2025" || r.Miles != 36509 {
		t.Errorf("row = %+v", r)
	}
}
