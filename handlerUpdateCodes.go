package main

import (
	"net/http"

	excelutils "github.com/jamjallred/sf_server_utils"
)

// POST /api/updateAirportCodes rebuilds the airport code map from
// Airport_Codes.xlsx.
func (cfg *apiConfig) handlerUpdateAirportCodes(w http.ResponseWriter, r *http.Request) {
	n, err := excelutils.RebuildAirportMap()
	if err != nil {
		respondErr(w, r, err, "could not rebuild the airport code map")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"codes": n})
}
