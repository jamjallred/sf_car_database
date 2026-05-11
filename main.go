package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
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

	godotenv.Load()

	port := os.Getenv("PORT")

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

	db, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}

	var dbName string
	err = db.QueryRow(context.Background(), "SELECT current_database()").Scan(&dbName)
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

	staticFS := http.FileServer(http.Dir("./app"))

	mux.Handle("/app/static/", http.StripPrefix("/app/static/", staticFS))

	mux.HandleFunc("/app/generate_grounded", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./app/generate_grounded.html")
	})

	mux.HandleFunc("/app/generate_final_report", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./app/generate_final_report.html")
	})

	mux.HandleFunc("/app", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/", http.StatusMovedPermanently)
	})

	mux.HandleFunc("/app/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/app/" {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, "./app/index.html")
	})

	mux.HandleFunc("/api/create_sheet", handlerCreateSheet)
	mux.HandleFunc("/api/generate_grounded", cfg.handlerGenerateGrounded)
	mux.HandleFunc("/api/generate_final_report", cfg.handlerGenerateFinalReport)

	mux.HandleFunc("/api/display_data", handlerDisplayTable)
	mux.HandleFunc("/api/displaytestdata", cfg.handlerDisplayTestData)

	mux.HandleFunc("/api/saveToDB", cfg.handlerSaveToDB)
	mux.HandleFunc("/api/updateAirportCodes", cfg.updateAirportCodes)

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
