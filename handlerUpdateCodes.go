package main

import (
	"net/http"

	excelutils "github.com/jamjallred/sf_server_utils"
)

func (cfg *apiConfig) updateAirportCodes(w http.ResponseWriter, r *http.Request) {

	if err := excelutils.CreateAirportMap(); err != nil {
		w.WriteHeader(500)
	}

}
