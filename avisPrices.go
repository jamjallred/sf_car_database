package main

// Avis Car Sales price lookup.
//
// aviscarsales.com fills its inventory pages from a JSON feed
// (POST /api/widget/ws-inv-data/getInventory). Rather than searching once per
// VIN, we download the whole used inventory a page at a time — a few dozen
// requests with a long pause between each — and keep a VIN → price snapshot in
// memory until it goes stale. Only one download runs at a time.
//
// Before each download we re-read robots.txt, refuse to fetch any path it
// disallows for "*", and honour its Crawl-delay if that is longer than ours.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	avisInventoryPage = "/used-inventory/index.htm"
	avisInventoryAPI  = "/api/widget/ws-inv-data/getInventory"
	avisMaxPages      = 400 // safety stop (~19,000 cars at 48 per page)
)

// Used when the page id can't be read from the inventory page.
const avisDefaultPageID = "avisbudgetgroupcarsales_SITEBUILDER_INVENTORY_SEARCH_RESULTS_AUTO_USED_V1_1"

var avisPageIDRe = regexp.MustCompile(`"pageId"\s*:\s*"(avisbudget[^"]*AUTO_USED[^"]*)"`)

// avisListing is one car as listed on aviscarsales.com.
type avisListing struct {
	VIN   string `json:"vin"`
	Price int    `json:"price"` // Avis asking price in whole dollars; 0 = no price shown
	Link  string `json:"link"`
	Title string `json:"title"`
}

// avisStatus is what the front end polls while a download runs.
type avisStatus struct {
	State      string     `json:"state"` // "empty" | "running" | "ready" | "error"
	Running    bool       `json:"running"`
	PagesDone  int        `json:"pagesDone"`
	PagesTotal int        `json:"pagesTotal"`
	Listings   int        `json:"listings"`
	FetchedAt  *time.Time `json:"fetchedAt,omitempty"`
	Stale      bool       `json:"stale"`
	DelaySecs  float64    `json:"delaySeconds"`
	Error      string     `json:"error,omitempty"`
}

type avisClient struct {
	http      *http.Client
	base      string
	userAgent string
	delay     time.Duration
	ttl       time.Duration
	sleep     func(context.Context, time.Duration) error // swapped out in tests

	mu         sync.Mutex
	listings   map[string]avisListing
	fetchedAt  time.Time
	running    bool
	pagesDone  int
	pagesTotal int
	lastErr    string
}

func newAvisClient(base, userAgent string, delay, ttl time.Duration) *avisClient {
	return &avisClient{
		http:      &http.Client{Timeout: 60 * time.Second},
		base:      strings.TrimRight(base, "/"),
		userAgent: userAgent,
		delay:     delay,
		ttl:       ttl,
		sleep:     sleepCtx,
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *avisClient) Status() avisStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.statusLocked()
}

func (c *avisClient) statusLocked() avisStatus {
	s := avisStatus{
		Running:    c.running,
		PagesDone:  c.pagesDone,
		PagesTotal: c.pagesTotal,
		Listings:   len(c.listings),
		DelaySecs:  c.delay.Seconds(),
		Error:      c.lastErr,
	}
	if !c.fetchedAt.IsZero() {
		t := c.fetchedAt
		s.FetchedAt = &t
		s.Stale = time.Since(c.fetchedAt) > c.ttl
	}
	switch {
	case c.running:
		s.State = "running"
	case c.listings != nil:
		s.State = "ready"
	case c.lastErr != "":
		s.State = "error"
	default:
		s.State = "empty"
	}
	return s
}

// Refresh starts a background download when there's no snapshot, the
// snapshot is stale, or force is set. It never starts a second download.
func (c *avisClient) Refresh(force bool) avisStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	fresh := c.listings != nil && time.Since(c.fetchedAt) <= c.ttl
	if c.running || (fresh && !force) {
		return c.statusLocked()
	}
	c.running = true
	c.pagesDone, c.pagesTotal, c.lastErr = 0, 0, ""
	go c.run()
	return c.statusLocked()
}

func (c *avisClient) run() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()

	started := time.Now()
	listings, err := c.download(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.running = false
	if err != nil {
		// Keep the previous snapshot, if any; it's better than nothing.
		c.lastErr = "couldn't download Avis prices: " + err.Error()
		log.Printf("avis: download failed after %d pages: %v", c.pagesDone, err)
		return
	}
	c.listings = listings
	c.fetchedAt = time.Now()
	log.Printf("avis: downloaded %d listings in %d pages (%s)", len(listings), c.pagesDone, time.Since(started).Round(time.Second))
}

// Lookup returns the snapshot's listings for vins plus when it was taken.
// ok is false when no snapshot has been downloaded yet.
func (c *avisClient) Lookup(vins []string) (found map[string]avisListing, fetchedAt time.Time, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.listings == nil {
		return nil, time.Time{}, false
	}
	found = make(map[string]avisListing)
	for _, v := range vins {
		v = normalizeVIN(v)
		if l, hit := c.listings[v]; hit {
			found[v] = l
		}
	}
	return found, c.fetchedAt, true
}

// ---------- download ----------

func (c *avisClient) download(ctx context.Context) (map[string]avisListing, error) {
	rules, crawlDelay, err := c.robots(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading robots.txt: %w", err)
	}
	for _, p := range []string{avisInventoryPage, avisInventoryAPI} {
		if !rules.allowed(p) {
			return nil, fmt.Errorf("robots.txt no longer allows %s, so the lookup is switched off", p)
		}
	}
	delay := c.delay
	if crawlDelay > delay {
		delay = crawlDelay
	}

	if err := c.sleep(ctx, delay); err != nil {
		return nil, err
	}
	pageID := avisDefaultPageID
	if html, err := c.get(ctx, avisInventoryPage, "text/html"); err != nil {
		log.Printf("avis: reading inventory page (using default page id): %v", err)
	} else if m := avisPageIDRe.FindSubmatch(html); m != nil {
		pageID = string(m[1])
	}

	listings := make(map[string]avisListing)
	start, pages := 0, 0
	for {
		if err := c.sleep(ctx, delay); err != nil {
			return nil, err
		}
		page, err := c.fetchPageWithRetry(ctx, pageID, start, delay)
		if err != nil {
			return nil, fmt.Errorf("page starting at car %d: %w", start, err)
		}
		pages++
		for _, l := range page.listings {
			if _, dup := listings[l.VIN]; !dup {
				listings[l.VIN] = l
			}
		}

		total := page.total
		size := page.pageSize
		if size <= 0 {
			size = len(page.listings)
		}
		c.mu.Lock()
		c.pagesDone = pages
		if size > 0 {
			c.pagesTotal = (total + size - 1) / size
		}
		c.mu.Unlock()

		start += len(page.listings)
		if len(page.listings) == 0 || start >= total {
			break
		}
		if pages >= avisMaxPages {
			return nil, fmt.Errorf("stopped after %d pages; the inventory looks larger than expected", pages)
		}
	}
	if len(listings) == 0 {
		return nil, errors.New("the Avis site returned no cars; its inventory feed may have changed")
	}
	return listings, nil
}

type avisPage struct {
	listings []avisListing
	total    int
	pageSize int
}

// fetchPageWithRetry retries a failed page twice, backing off for a long time
// (much longer when the site says it's busy) before giving up.
func (c *avisClient) fetchPageWithRetry(ctx context.Context, pageID string, start int, delay time.Duration) (avisPage, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			wait := delay * 5
			var se *statusError
			if errors.As(lastErr, &se) && (se.code == http.StatusTooManyRequests || se.code == http.StatusServiceUnavailable) {
				wait = delay * 20
			}
			if err := c.sleep(ctx, wait); err != nil {
				return avisPage{}, err
			}
		}
		page, err := c.fetchPage(ctx, pageID, start)
		if err == nil {
			return page, nil
		}
		lastErr = err
		var se *statusError
		if errors.As(err, &se) && (se.code == http.StatusForbidden || se.code == http.StatusUnauthorized || se.code == http.StatusNotFound) {
			break // won't fix itself; don't keep knocking
		}
	}
	return avisPage{}, lastErr
}

func (c *avisClient) fetchPage(ctx context.Context, pageID string, start int) (avisPage, error) {
	params := map[string][]string{}
	if start > 0 {
		params["start"] = []string{strconv.Itoa(start)}
	}
	body := map[string]any{
		"siteId":              "avisbudgetgroupcarsales",
		"locale":              "en_US",
		"device":              "DESKTOP",
		"pageAlias":           "INVENTORY_LISTING_DEFAULT_AUTO_USED",
		"pageId":              pageID,
		"windowId":            "inventory-data-bus1",
		"widgetName":          "ws-inv-data",
		"inventoryParameters": params,
		"preferences":         map[string]string{"pageSize": "48", "listing.config.id": "auto-used"},
		"includePricing":      true,
	}
	raw, _ := json.Marshal(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+avisInventoryAPI, bytes.NewReader(raw))
	if err != nil {
		return avisPage{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Referer", c.base+avisInventoryPage)
	data, err := c.do(req)
	if err != nil {
		return avisPage{}, err
	}
	return parseAvisInventory(data)
}

// ---------- JSON parsing ----------

type avisInventoryResponse struct {
	PageInfo struct {
		TotalCount int `json:"totalCount"`
		PageSize   int `json:"pageSize"`
	} `json:"pageInfo"`
	Inventory []struct {
		VIN     string          `json:"vin"`
		Link    string          `json:"link"`
		Title   json.RawMessage `json:"title"` // ["2025 Jeep", "Compass Latitude"]
		Pricing struct {
			DPrice []struct {
				TypeClass string `json:"typeClass"`
				Value     string `json:"value"`
			} `json:"dprice"`
		} `json:"pricing"`
		TrackingPricing map[string]any `json:"trackingPricing"`
	} `json:"inventory"`
	Message any `json:"message"`
}

func parseAvisInventory(data []byte) (avisPage, error) {
	var r avisInventoryResponse
	if err := json.Unmarshal(data, &r); err != nil {
		return avisPage{}, fmt.Errorf("unexpected response from the inventory feed: %w", err)
	}
	page := avisPage{total: r.PageInfo.TotalCount, pageSize: r.PageInfo.PageSize}
	if len(r.Inventory) == 0 && r.PageInfo.TotalCount == 0 && r.Message != nil {
		return page, fmt.Errorf("inventory feed said: %v", r.Message)
	}
	for _, v := range r.Inventory {
		vin := normalizeVIN(v.VIN)
		if vin == "" {
			continue
		}
		// The "Avis Price" shown on the site is the askingPrice entry; the
		// other dprice entries are KBB value, fees and the after-fees total.
		price := 0
		for _, d := range v.Pricing.DPrice {
			if d.TypeClass == "askingPrice" {
				price = parseDollars(d.Value)
				break
			}
		}
		if price == 0 {
			for _, k := range []string{"salePrice", "internetPrice", "askingPrice"} {
				if s, ok := v.TrackingPricing[k].(string); ok {
					if price = parseDollars(s); price > 0 {
						break
					}
				}
			}
		}
		link := v.Link
		if strings.HasPrefix(link, "/") {
			link = "https://www.aviscarsales.com" + link
		}
		page.listings = append(page.listings, avisListing{VIN: vin, Price: price, Link: link, Title: joinTitle(v.Title)})
	}
	return page, nil
}

func joinTitle(raw json.RawMessage) string {
	var parts []string
	if json.Unmarshal(raw, &parts) == nil {
		return strings.Join(parts, " ")
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

// parseDollars turns "$18,199", "18199" or "18199.00" into 18199. Anything
// without digits is 0.
func parseDollars(s string) int {
	var b strings.Builder
	for _, r := range s {
		if (r >= '0' && r <= '9') || r == '.' {
			b.WriteRune(r)
		}
	}
	f, err := strconv.ParseFloat(b.String(), 64)
	if err != nil || f < 0 {
		return 0
	}
	return int(math.Round(f))
}

func normalizeVIN(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

// ---------- HTTP ----------

type statusError struct {
	code int
	url  string
}

func (e *statusError) Error() string { return fmt.Sprintf("HTTP %d from %s", e.code, e.url) }

func (c *avisClient) get(ctx context.Context, path, accept string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	return c.do(req)
}

func (c *avisClient) do(req *http.Request) ([]byte, error) {
	req.Header.Set("User-Agent", c.userAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &statusError{code: resp.StatusCode, url: req.URL.Path}
	}
	return data, nil
}

// ---------- robots.txt ----------

type robotsRules struct{ disallow []string }

// allowed reports whether path is outside every Disallow rule. Rules support
// the common "*" wildcard and "$" end anchor.
func (r robotsRules) allowed(path string) bool {
	for _, rule := range r.disallow {
		if robotsMatch(rule, path) {
			return false
		}
	}
	return true
}

func robotsMatch(rule, path string) bool {
	anchored := strings.HasSuffix(rule, "$")
	rule = strings.TrimSuffix(rule, "$")
	expr := "^" + strings.ReplaceAll(regexp.QuoteMeta(rule), `\*`, ".*")
	if anchored {
		expr += "$"
	}
	re, err := regexp.Compile(expr)
	return err == nil && re.MatchString(path)
}

// robots reads the "User-agent: *" group. A missing robots.txt (404) means
// everything is allowed.
func (c *avisClient) robots(ctx context.Context) (robotsRules, time.Duration, error) {
	data, err := c.get(ctx, "/robots.txt", "text/plain")
	var se *statusError
	if errors.As(err, &se) && se.code == http.StatusNotFound {
		return robotsRules{}, 0, nil
	}
	if err != nil {
		return robotsRules{}, 0, err
	}
	rules, delay := parseRobots(data)
	return rules, delay, nil
}

func parseRobots(data []byte) (robotsRules, time.Duration) {
	var rules robotsRules
	var delay time.Duration
	inStar, inAgents := false, false
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		val = strings.TrimSpace(val)
		if key == "user-agent" {
			if !inAgents { // a new group starts
				inStar = false
			}
			inAgents = true
			if val == "*" {
				inStar = true
			}
			continue
		}
		inAgents = false
		if !inStar {
			continue
		}
		switch key {
		case "disallow":
			if val != "" {
				rules.disallow = append(rules.disallow, val)
			}
		case "crawl-delay":
			if f, err := strconv.ParseFloat(val, 64); err == nil && f > 0 {
				delay = time.Duration(f * float64(time.Second))
			}
		}
	}
	return rules, delay
}
