package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/jamjallred/sf_car_database/internal/database"
	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
)

type apiConfig struct {
	dbQueries      *database.Queries
	dbQueries_test *database.Queries
}

func main() {

	const filepath = "./static"
	const port = "52431"

	godotenv.Load()

	env := os.Getenv("ENV") // "prod" or "test"
	if env == "" {
		env = "test" // default test
	}

	var dbURL string
	if env == "prod" {
		dbURL = os.Getenv("DB_URL")
	} else {
		dbURL = os.Getenv("DB_TEST_URL")
	}

	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}

	var dbName string
	err = db.QueryRow("SELECT current_database()").Scan(&dbName)
	if err != nil {
		log.Fatalf("Failed to verify database connection: %v", err)
	}

	log.Printf("✓ Connected to database: %s (environment: %s)", dbName, env)

	// Sanity check
	if env == "prod" && strings.Contains(dbName, "test") {
		log.Fatal("DANGER: Running in production but connected to test database")
	}

	cfg := &apiConfig{
		dbQueries: database.New(db),
	}

	mux := http.NewServeMux()

	mux.Handle("/app/", http.StripPrefix("/app/", http.FileServer(http.Dir(filepath))))
	mux.HandleFunc("/api/create_sheet", handlerCreateSheet)
	mux.HandleFunc("/api/display_data", handlerDisplayTable)
	mux.HandleFunc("/api/displaytestdata", cfg.handlerDisplayTestData)

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
