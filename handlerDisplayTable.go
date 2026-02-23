package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
)

func handlerDisplayTable(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func (cfg *apiConfig) handlerDisplayTestData(w http.ResponseWriter, r *http.Request) {

	log.Println("successfully pattern matched")
	rows, err := cfg.dbQueries.GetFirstXRows(r.Context(), 20)
	if err != nil {
		http.Error(w, "Database error", http.StatusInternalServerError)
		log.Printf("Query error: %v", err)
		return
	}

	fmt.Println(rows)

	w.Header().Set("Content-Type", "application/json")

	if err := json.NewEncoder(w).Encode(rows); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		log.Printf("JSON encoding error: %v", err)
		return
	}
}
