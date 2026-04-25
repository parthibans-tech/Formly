// Package clientinfo enriches an authenticated HTTP request with the
// metadata you want on every audit row: parsed user-agent (browser, OS,
// device), the resolved client IP, and a best-effort geolocation.
//
// Two geolocation sources are merged here:
//
//   - **Browser** — when the front-end captures `navigator.geolocation`
//     and forwards `{lat, lng, accuracy}` on /v1/auth/login, we trust it
//     because the user explicitly granted permission. Source = "browser".
//
//   - **IP** — fallback for requests without a browser-supplied location
//     (server-to-server calls, MFA verifications, /v1/me hits, etc.).
//     Backed by ip-api.com, called with a short timeout + cached so we
//     never block a login by more than ~250ms. Source = "ip".
//
// The enrichment is best-effort: a failed lookup or a private IP returns
// an empty Geo struct, never an error. The audit row still gets the IP
// and parsed UA — geo is the optional cherry on top.
package clientinfo

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// BrowserGeo is what the client reports from navigator.geolocation. All
// fields are optional; we only use a row if Lat AND Lng are non-zero
// (Accuracy alone is never enough to plot anything).
type BrowserGeo struct {
	Lat      float64 `json:"lat,omitempty"`
	Lng      float64 `json:"lng,omitempty"`
	Accuracy float64 `json:"accuracy,omitempty"`
	TZ       string  `json:"tz,omitempty"`
}

// Geo is the resolved location, regardless of source.
type Geo struct {
	Country     string  `json:"country,omitempty"`
	CountryCode string  `json:"countryCode,omitempty"`
	Region      string  `json:"region,omitempty"`
	City        string  `json:"city,omitempty"`
	Lat         float64 `json:"lat,omitempty"`
	Lng         float64 `json:"lng,omitempty"`
	TZ          string  `json:"tz,omitempty"`
	Source      string  `json:"source,omitempty"` // "browser" | "ip" | ""
}

// ClientInfo is the bundle attached to every auth audit event. The
// flat layout is intentional — Postgres' `meta` column stores it as
// JSONB, and a flat shape makes ad-hoc dashboards easier.
type ClientInfo struct {
	IP             string `json:"ip,omitempty"`
	UserAgent      string `json:"userAgent,omitempty"`
	Browser        string `json:"browser,omitempty"`
	BrowserVersion string `json:"browserVersion,omitempty"`
	OS             string `json:"os,omitempty"`
	OSVersion      string `json:"osVersion,omitempty"`
	DeviceType     string `json:"deviceType,omitempty"` // desktop | mobile | tablet | bot | unknown
	DeviceVendor   string `json:"deviceVendor,omitempty"`
	Geo            Geo    `json:"geo,omitempty"`
}

// ToMeta flattens a ClientInfo into a map[string]any for the audit row's
// jsonb meta column. Empty fields are dropped so the meta blob stays tidy.
func (ci ClientInfo) ToMeta() map[string]any {
	m := map[string]any{}
	if ci.IP != "" {
		m["ip"] = ci.IP
	}
	if ci.Browser != "" {
		m["browser"] = ci.Browser
	}
	if ci.BrowserVersion != "" {
		m["browserVersion"] = ci.BrowserVersion
	}
	if ci.OS != "" {
		m["os"] = ci.OS
	}
	if ci.OSVersion != "" {
		m["osVersion"] = ci.OSVersion
	}
	if ci.DeviceType != "" {
		m["deviceType"] = ci.DeviceType
	}
	if ci.DeviceVendor != "" {
		m["deviceVendor"] = ci.DeviceVendor
	}
	if g := ci.Geo; g.Country != "" || g.City != "" || g.Lat != 0 || g.Lng != 0 {
		gm := map[string]any{}
		if g.Country != "" {
			gm["country"] = g.Country
		}
		if g.CountryCode != "" {
			gm["countryCode"] = g.CountryCode
		}
		if g.Region != "" {
			gm["region"] = g.Region
		}
		if g.City != "" {
			gm["city"] = g.City
		}
		if g.Lat != 0 || g.Lng != 0 {
			gm["lat"] = g.Lat
			gm["lng"] = g.Lng
		}
		if g.TZ != "" {
			gm["tz"] = g.TZ
		}
		if g.Source != "" {
			gm["source"] = g.Source
		}
		m["geo"] = gm
	}
	return m
}

// FromRequest builds a ClientInfo for `r`, merging in `bg` if the front
// end captured browser geolocation. The function blocks on the IP geo
// lookup with a short timeout — never longer than 1.5s.
func FromRequest(ctx context.Context, r *http.Request, bg *BrowserGeo) ClientInfo {
	ci := ClientInfo{
		IP:        ClientIP(r),
		UserAgent: r.UserAgent(),
	}
	parseUA(r.UserAgent(), &ci)

	// Browser-supplied geolocation wins when present (the user explicitly
	// granted permission, so it's both more accurate and less likely to
	// fail than a remote IP lookup).
	if bg != nil && bg.Lat != 0 && bg.Lng != 0 {
		ci.Geo.Lat = bg.Lat
		ci.Geo.Lng = bg.Lng
		ci.Geo.TZ = bg.TZ
		ci.Geo.Source = "browser"
		// Reverse-geocode for country/city is too expensive to do
		// inline. Skip — the lat/lng alone is enough for any dashboard
		// that wants to show a pin.
		return ci
	}

	// IP fallback. Skip private / loopback / empty.
	if ip := net.ParseIP(ci.IP); ip != nil && !ip.IsLoopback() && !ip.IsPrivate() {
		if g := lookupIP(ctx, ci.IP); g.Country != "" || g.Lat != 0 {
			g.Source = "ip"
			ci.Geo = g
		}
	}
	return ci
}

// ClientIP picks the most-trusted IP from the request: X-Forwarded-For
// first hop > X-Real-IP > RemoteAddr. Strips port from RemoteAddr.
func ClientIP(r *http.Request) string {
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.IndexByte(v, ','); i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	addr := r.RemoteAddr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return addr
}

// -- UA parsing -----------------------------------------------------------

// Tiny heuristic parser. Handles the long tail of "what device is this?"
// well enough for an audit row — we don't need to detect exotic browsers
// or build feature-detection trees.

var (
	reBrowserEdge    = regexp.MustCompile(`Edg(?:e|A|iOS)?/(\d+(?:\.\d+)?)`)
	reBrowserChrome  = regexp.MustCompile(`Chrome/(\d+(?:\.\d+)?)`)
	reBrowserSafari  = regexp.MustCompile(`Version/(\d+(?:\.\d+)?).*Safari/`)
	reBrowserFirefox = regexp.MustCompile(`Firefox/(\d+(?:\.\d+)?)`)
	reBrowserOpera   = regexp.MustCompile(`OPR/(\d+(?:\.\d+)?)`)
	reOSWindows      = regexp.MustCompile(`Windows NT (\d+\.\d+)`)
	reOSMac          = regexp.MustCompile(`Mac OS X (\d+[._]\d+(?:[._]\d+)?)`)
	reOSAndroid      = regexp.MustCompile(`Android (\d+(?:\.\d+)?)`)
	reOSIOS          = regexp.MustCompile(`OS (\d+[._]\d+(?:[._]\d+)?) like Mac OS X`)
	reOSLinux        = regexp.MustCompile(`Linux`)
)

func parseUA(ua string, ci *ClientInfo) {
	if ua == "" {
		ci.DeviceType = "unknown"
		return
	}
	low := strings.ToLower(ua)

	// Bot detection — keep simple; bots rarely log in but they hit /me etc.
	for _, k := range []string{"bot", "spider", "crawler", "curl", "wget", "go-http-client", "python-requests"} {
		if strings.Contains(low, k) {
			ci.DeviceType = "bot"
			ci.Browser = "Bot"
			return
		}
	}

	// Browser — order matters (Edge advertises Chrome too, etc).
	switch {
	case reBrowserEdge.MatchString(ua):
		ci.Browser = "Edge"
		if m := reBrowserEdge.FindStringSubmatch(ua); len(m) > 1 {
			ci.BrowserVersion = m[1]
		}
	case reBrowserOpera.MatchString(ua):
		ci.Browser = "Opera"
		if m := reBrowserOpera.FindStringSubmatch(ua); len(m) > 1 {
			ci.BrowserVersion = m[1]
		}
	case reBrowserChrome.MatchString(ua):
		ci.Browser = "Chrome"
		if m := reBrowserChrome.FindStringSubmatch(ua); len(m) > 1 {
			ci.BrowserVersion = m[1]
		}
	case reBrowserFirefox.MatchString(ua):
		ci.Browser = "Firefox"
		if m := reBrowserFirefox.FindStringSubmatch(ua); len(m) > 1 {
			ci.BrowserVersion = m[1]
		}
	case reBrowserSafari.MatchString(ua):
		ci.Browser = "Safari"
		if m := reBrowserSafari.FindStringSubmatch(ua); len(m) > 1 {
			ci.BrowserVersion = m[1]
		}
	}

	// OS.
	switch {
	case reOSWindows.MatchString(ua):
		ci.OS = "Windows"
		if m := reOSWindows.FindStringSubmatch(ua); len(m) > 1 {
			ci.OSVersion = m[1]
		}
	case reOSIOS.MatchString(ua):
		ci.OS = "iOS"
		if m := reOSIOS.FindStringSubmatch(ua); len(m) > 1 {
			ci.OSVersion = strings.ReplaceAll(m[1], "_", ".")
		}
	case reOSMac.MatchString(ua):
		ci.OS = "macOS"
		if m := reOSMac.FindStringSubmatch(ua); len(m) > 1 {
			ci.OSVersion = strings.ReplaceAll(m[1], "_", ".")
		}
	case reOSAndroid.MatchString(ua):
		ci.OS = "Android"
		if m := reOSAndroid.FindStringSubmatch(ua); len(m) > 1 {
			ci.OSVersion = m[1]
		}
	case reOSLinux.MatchString(ua):
		ci.OS = "Linux"
	}

	// Device class.
	switch {
	case strings.Contains(low, "ipad") || strings.Contains(low, "tablet"):
		ci.DeviceType = "tablet"
	case strings.Contains(low, "iphone") || strings.Contains(low, "android") || strings.Contains(low, "mobile"):
		ci.DeviceType = "mobile"
	default:
		ci.DeviceType = "desktop"
	}

	// Vendor — useful when the operator is triaging "what's this?".
	switch {
	case strings.Contains(low, "iphone") || strings.Contains(low, "ipad") || strings.Contains(low, "macintosh"):
		ci.DeviceVendor = "Apple"
	case strings.Contains(low, "samsung"):
		ci.DeviceVendor = "Samsung"
	case strings.Contains(low, "pixel"):
		ci.DeviceVendor = "Google"
	}
}

// -- IP geo ---------------------------------------------------------------

// ip-api.com is free, requires no API key, and is rate-limited to
// 45 req/min from a given source — fine for our login volume. We still
// cache aggressively because most logins from a given user/org reuse the
// same IP for hours.

type cacheEntry struct {
	geo Geo
	at  time.Time
}

var (
	geoCacheMu  sync.RWMutex
	geoCache    = map[string]cacheEntry{}
	geoCacheTTL = 24 * time.Hour

	geoLookupTimeout = 1500 * time.Millisecond

	// Overridable in tests; production hits the public endpoint.
	geoEndpointFunc = func(ip string) string {
		return "http://ip-api.com/json/" + ip + "?fields=status,country,countryCode,regionName,city,lat,lon,timezone"
	}
)

type ipAPIResponse struct {
	Status      string  `json:"status"`
	Country     string  `json:"country"`
	CountryCode string  `json:"countryCode"`
	RegionName  string  `json:"regionName"`
	City        string  `json:"city"`
	Lat         float64 `json:"lat"`
	Lon         float64 `json:"lon"`
	Timezone    string  `json:"timezone"`
}

func lookupIP(parent context.Context, ip string) Geo {
	geoCacheMu.RLock()
	if e, ok := geoCache[ip]; ok && time.Since(e.at) < geoCacheTTL {
		geoCacheMu.RUnlock()
		return e.geo
	}
	geoCacheMu.RUnlock()

	ctx, cancel := context.WithTimeout(parent, geoLookupTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, geoEndpointFunc(ip), nil)
	if err != nil {
		return Geo{}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return Geo{}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Geo{}
	}
	var r ipAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return Geo{}
	}
	if r.Status != "success" {
		return Geo{}
	}
	g := Geo{
		Country:     r.Country,
		CountryCode: r.CountryCode,
		Region:      r.RegionName,
		City:        r.City,
		Lat:         r.Lat,
		Lng:         r.Lon,
		TZ:          r.Timezone,
	}
	geoCacheMu.Lock()
	geoCache[ip] = cacheEntry{geo: g, at: time.Now()}
	geoCacheMu.Unlock()
	return g
}
