package main

import (
	"database/sql"
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
	const port = "52431"

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

	mux.Handle("/app/", http.StripPrefix("/app/", http.FileServer(http.Dir(filepath))))
	mux.HandleFunc("/api/create_sheet", handlerCreateSheet)

	server := &http.Server{
		Addr:    os.Getenv("BIND_ADDR_PUBLIC") + ":" + port,
		Handler: mux,
	}

	cfg.doNothing()

	log.Printf("Server is live")
	log.Printf("Serving files from %s on port: %s\n", filepath, port)
	log.Fatal(server.ListenAndServe())
	log.Printf("Server closed")

}

func (cfg *apiConfig) doNothing() {
}

func (cfg *apiConfig) handlerTest(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("It is working!"))
	w.WriteHeader(http.StatusOK)
}
