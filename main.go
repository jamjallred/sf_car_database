package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jamjallred/sf_car_database/internal/database"
	"github.com/joho/godotenv"
)

type apiConfig struct {
	db        *pgxpool.Pool
	dbQueries *database.Queries

	// Generated workbooks are also archived here (ABSOLUTE_DIRECTORY).
	reportDir        string
	groundedPrefix   string
	finalPrefix      string
	nationwidePrefix string

	// Sales reps credited on the final report (EMPLOYEE_1..EMPLOYEE_N).
	team []string

	// Avis Car Sales price snapshot for the price check page.
	avis *avisClient
}

func main() {
	_ = godotenv.Load()

	env := envOr("ENV", "test") // "prod" or "test"
	dbURL := os.Getenv("DB_TEST_URL")
	if env == "prod" {
		dbURL = os.Getenv("DB_URL")
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	var dbName string
	if err := db.QueryRow(ctx, "SELECT current_database()").Scan(&dbName); err != nil {
		log.Fatalf("failed to verify database connection: %v", err)
	}
	log.Printf("✓ connected to database %s (environment: %s)", dbName, env)

	if env == "prod" && strings.Contains(dbName, "test") {
		log.Fatal("DANGER: running in production but connected to a test database")
	}

	cfg := &apiConfig{
		db:               db,
		dbQueries:        database.New(db),
		reportDir:        os.Getenv("ABSOLUTE_DIRECTORY"),
		groundedPrefix:   os.Getenv("FILENAME_PREFIX"),
		finalPrefix:      os.Getenv("FILENAME_PREFIX_FINAL_REPORT"),
		nationwidePrefix: envOr("FILENAME_PREFIX_NATIONWIDE", "nationwide_"),
		team:             teamFromEnv(),
		avis: newAvisClient(
			envOr("AVIS_BASE_URL", "https://www.aviscarsales.com"),
			envOr("AVIS_USER_AGENT", "SoonerFleet-PriceCheck/1.0"),
			durationEnv("AVIS_REQUEST_DELAY", 6*time.Second),
			durationEnv("AVIS_CACHE_TTL", 6*time.Hour),
		),
	}

	server := &http.Server{
		Addr:              os.Getenv("BIND_ADDR_PUBLIC") + ":" + envOr("PORT", "8080"),
		Handler:           withRecovery(withLogging(cfg.routes())),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      5 * time.Minute, // sheet generation can take a while
		IdleTimeout:       2 * time.Minute,
	}

	go func() {
		log.Printf("server is live on %s", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Print("shutting down…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	log.Print("server closed")
}

func (cfg *apiConfig) routes() http.Handler {
	mux := http.NewServeMux()

	page := func(file string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			http.ServeFile(w, r, "./app/"+file)
		}
	}
	redirect := func(to string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, to, http.StatusMovedPermanently)
		}
	}

	// Pages
	mux.HandleFunc("GET /{$}", redirect("/app/"))
	mux.HandleFunc("GET /app", redirect("/app/"))
	mux.HandleFunc("GET /app/{$}", page("index.html"))
	mux.HandleFunc("GET /app/inventory", page("inventory.html"))
	mux.HandleFunc("GET /app/nationwide", page("nationwide.html"))
	mux.HandleFunc("GET /app/generate_grounded", page("generate_grounded.html"))
	mux.HandleFunc("GET /app/generate_final_report", page("generate_final_report.html"))
	mux.HandleFunc("GET /app/price_check", page("price_check.html"))
	mux.Handle("GET /app/static/", http.StripPrefix("/app/static/", http.FileServer(http.Dir("./app"))))

	// API
	mux.HandleFunc("GET /healthz", cfg.handlerHealth)
	mux.HandleFunc("GET /api/team", cfg.handlerTeam)
	mux.HandleFunc("GET /api/cars", cfg.handlerSearchCars)
	mux.HandleFunc("GET /api/cars/states", cfg.handlerListStates)
	mux.HandleFunc("POST /api/create_sheet", cfg.handlerCreateSheet)
	mux.HandleFunc("POST /api/generate_grounded", cfg.handlerGenerateGrounded)
	mux.HandleFunc("POST /api/generate_final_report", cfg.handlerGenerateFinalReport)
	mux.HandleFunc("POST /api/saveToDB", cfg.handlerSaveToDB)
	mux.HandleFunc("POST /api/updateAirportCodes", cfg.handlerUpdateAirportCodes)
	mux.HandleFunc("POST /api/price_check/upload", cfg.handlerPriceCheckUpload)
	mux.HandleFunc("GET /api/avis/status", cfg.handlerAvisStatus)
	mux.HandleFunc("POST /api/avis/refresh", cfg.handlerAvisRefresh)
	mux.HandleFunc("POST /api/avis/lookup", cfg.handlerAvisLookup)

	return mux
}

func (cfg *apiConfig) handlerHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := cfg.db.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database unreachable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (cfg *apiConfig) handlerTeam(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string][]string{"team": cfg.team})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// durationEnv reads a Go duration like "6s" or "6h", or a plain number of
// seconds, falling back when it's unset or invalid.
func durationEnv(key string, fallback time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	if d, err := time.ParseDuration(v); err == nil && d > 0 {
		return d
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	log.Printf("ignoring %s=%q (expected something like 6s or 6h)", key, v)
	return fallback
}

// teamFromEnv reads EMPLOYEE_1, EMPLOYEE_2, … until the first missing one.
func teamFromEnv() []string {
	var team []string
	for i := 1; ; i++ {
		name := strings.TrimSpace(os.Getenv("EMPLOYEE_" + strconv.Itoa(i)))
		if name == "" {
			return team
		}
		team = append(team, name)
	}
}
