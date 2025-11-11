package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/jamjallred/sf_car_database/internal/database"
	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
)

type apiConfig struct {
	dbQueries *database.Queries
}

func main() {

	const filepath = "."
	const port = "8080"

	godotenv.Load()
	dbURL := os.Getenv("DB_URL")

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatal("Failed to open database")
	}

	cfg := &apiConfig{
		dbQueries: database.New(db),
	}

	mux := http.NewServeMux()

	mux.Handle("/app/", http.StripPrefix("/app", http.FileServer(http.Dir(filepath))))

	server := &http.Server{
		Addr:    os.Getenv("BIND_ADDR") + ":" + port,
		Handler: mux,
	}

	log.Printf("Serving files from %s on port: %s\n", filepath, port)
	log.Fatal(server.ListenAndServe())

	cfg.doNothing()

	fmt.Println("Server exists")
}

func (cfg *apiConfig) doNothing() {
}
