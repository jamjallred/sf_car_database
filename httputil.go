package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

const maxUploadBytes = 32 << 20 // 32 MB

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encoding JSON response: %v", err)
	}
}

// writeError sends {"error": msg}; the front end shows msg to the user.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// clientError is an error whose message is safe to show to the user.
type clientError struct {
	status int
	msg    string
}

func (e *clientError) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return &clientError{status: http.StatusBadRequest, msg: fmt.Sprintf(format, args...)}
}

// respondErr maps clientErrors to their status and logs everything else as a
// 500 with a generic message.
func respondErr(w http.ResponseWriter, r *http.Request, err error, publicMsg string) {
	var ce *clientError
	if errors.As(err, &ce) {
		writeError(w, ce.status, ce.msg)
		return
	}
	log.Printf("%s %s: %v", r.Method, r.URL.Path, err)
	writeError(w, http.StatusInternalServerError, publicMsg)
}

// parseUploads limits the request size and parses the multipart form.
func parseUploads(w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return &clientError{http.StatusRequestEntityTooLarge, "upload is larger than 32 MB"}
		}
		return badRequest("could not read the upload: %v", err)
	}
	return nil
}

// formFile returns the uploaded file in field, checking its extension.
func formFile(r *http.Request, field, ext, label string) (multipart.File, *multipart.FileHeader, error) {
	f, h, err := r.FormFile(field)
	if err != nil {
		return nil, nil, badRequest("missing %s (%s)", label, ext)
	}
	if !strings.EqualFold(filepath.Ext(h.Filename), ext) {
		f.Close()
		return nil, nil, badRequest("%s must be a %s file, got %q", label, ext, h.Filename)
	}
	return f, h, nil
}

// readWorkbookUpload accepts either a multipart upload in field "file" or a
// raw .xlsx request body (what older clients send).
func readWorkbookUpload(w http.ResponseWriter, r *http.Request) (*excelize.File, error) {
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := parseUploads(w, r); err != nil {
			return nil, err
		}
		f, _, err := formFile(r, "file", ".xlsx", "spreadsheet")
		if err != nil {
			return nil, err
		}
		defer f.Close()
		wb, err := excelize.OpenReader(f)
		if err != nil {
			return nil, badRequest("that file isn't a readable .xlsx workbook")
		}
		return wb, nil
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUploadBytes))
	if err != nil {
		return nil, badRequest("could not read the upload")
	}
	wb, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		return nil, badRequest("that file isn't a readable .xlsx workbook")
	}
	return wb, nil
}

// sendWorkbook streams wb as a download named prefix+YYYY-MM-DD.xlsx and
// archives a copy in cfg.reportDir. Archiving failures are logged, not fatal.
func (cfg *apiConfig) sendWorkbook(w http.ResponseWriter, wb *excelize.File, prefix string) {
	name := prefix + time.Now().Format("2006-01-02") + ".xlsx"

	var buf bytes.Buffer
	if err := wb.Write(&buf); err != nil {
		log.Printf("serialising %s: %v", name, err)
		writeError(w, http.StatusInternalServerError, "could not build the spreadsheet")
		return
	}

	archive := filepath.Join(cfg.reportDir, name)
	if err := os.WriteFile(archive, buf.Bytes(), 0o644); err != nil {
		log.Printf("archiving %s: %v", archive, err)
	}

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	w.Header().Set("Content-Length", fmt.Sprint(buf.Len()))
	w.Header().Set("Access-Control-Expose-Headers", "Content-Disposition, X-Sheet-Summary")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(buf.Bytes()); err != nil {
		log.Printf("sending %s: %v", name, err)
	}
}

// --- middleware ---

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if strings.HasPrefix(r.URL.Path, "/app/static/") && rec.status < 400 {
			return // keep the log readable
		}
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

func withRecovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				log.Printf("panic in %s %s: %v\n%s", r.Method, r.URL.Path, v, debug.Stack())
				writeError(w, http.StatusInternalServerError, "unexpected server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
