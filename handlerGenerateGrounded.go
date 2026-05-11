package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	excelutils "github.com/jamjallred/sf_server_utils"
	"github.com/joho/godotenv"
)

func (cfg *apiConfig) handlerGenerateGrounded(w http.ResponseWriter, r *http.Request) {
	fmt.Println("request worked")
	godotenv.Load()

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		http.Error(w, "bad form data", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	if !strings.HasSuffix(strings.ToLower(header.Filename), ".csv") {
		http.Error(w, "only .csv files allowed", http.StatusBadRequest)
		return
	}

	rdr := csv.NewReader(file)
	records, err := rdr.ReadAll()
	if err != nil {
		http.Error(w, "invalid csv", http.StatusBadRequest)
		return
	}

	savePath := os.Getenv("ABSOLUTE_DIRECTORY") + os.Getenv("FILENAME_PREFIX") + time.Now().Format("2006-01-02") + ".xlsx"
	excelutils.GenerateGrounded(records, savePath, r.Context(), cfg)

	f, err := os.Open(savePath)
	if err != nil {
		http.Error(w, ".xlsx file not found", http.StatusInternalServerError)
	}
	defer f.Close()

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	downloadName := filepath.Base(savePath)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, downloadName))
	w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition")

	if _, err := io.Copy(w, f); err != nil {
		http.Error(w, "failed to send file", http.StatusInternalServerError)
		return
	}

}
