// Package i18n provides per-locale number / currency / date formatting and a
// lookup-based translation helper. Templates reach these through locale-aware
// overrides of the existing formatter helpers plus a new `t` helper.
package i18n

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/currency"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"golang.org/x/text/number"
)

// Sets maps a locale code (e.g. "en-US") to a dictionary of translation keys.
type Sets map[string]map[string]string

// Config is the portion of config_json we care about.
type Config struct {
	DefaultLocale string   `json:"locale,omitempty"`
	Locales       []string `json:"locales,omitempty"`
	Translations  Sets     `json:"translations,omitempty"`
}

// FromConfig extracts the i18n config (if any) out of config_json bytes.
// Returns a zero Config if the template doesn't declare any translations.
func FromConfig(cfg []byte) Config {
	if len(cfg) == 0 {
		return Config{}
	}
	var c Config
	_ = json.Unmarshal(cfg, &c)
	if c.DefaultLocale == "" {
		c.DefaultLocale = "en-US"
	}
	return c
}

// ResolveLocale picks the locale to render with: the data payload's `locale`
// key takes priority, falling back to the template's default locale.
func ResolveLocale(cfg Config, data map[string]interface{}) string {
	if data != nil {
		if v, ok := data["locale"].(string); ok && v != "" {
			return v
		}
	}
	if cfg.DefaultLocale != "" {
		return cfg.DefaultLocale
	}
	return "en-US"
}

// Translate looks up a key in the requested locale's dictionary, falling back
// to the default locale, then to the key itself. Supports {0}, {1}, …
// positional interpolation.
func Translate(cfg Config, locale, key string, args ...interface{}) string {
	if cfg.Translations != nil {
		if dict, ok := cfg.Translations[locale]; ok {
			if v, ok := dict[key]; ok {
				return interpolate(v, args)
			}
		}
		if cfg.DefaultLocale != "" && cfg.DefaultLocale != locale {
			if dict, ok := cfg.Translations[cfg.DefaultLocale]; ok {
				if v, ok := dict[key]; ok {
					return interpolate(v, args)
				}
			}
		}
	}
	// Fallback: return the key itself so authors notice missing translations.
	return key
}

func interpolate(s string, args []interface{}) string {
	if len(args) == 0 {
		return s
	}
	for i, a := range args {
		s = strings.ReplaceAll(s, "{"+strconv.Itoa(i)+"}", fmt.Sprint(a))
	}
	return s
}

// -- Locale-aware formatters ----------------------------------------------

// printer caches a message.Printer per locale.
func printerFor(locale string) *message.Printer {
	tag, err := language.Parse(locale)
	if err != nil {
		tag = language.AmericanEnglish
	}
	return message.NewPrinter(tag)
}

// FormatNumber renders a decimal number honouring the locale's thousands /
// decimal separators. `decimals` controls fraction digits.
func FormatNumber(locale string, v interface{}, decimals int) string {
	f, ok := toFloat(v)
	if !ok {
		return fmt.Sprint(v)
	}
	if decimals < 0 {
		decimals = 0
	}
	p := printerFor(locale)
	return p.Sprintf("%v", number.Decimal(f,
		number.MinFractionDigits(decimals),
		number.MaxFractionDigits(decimals),
	))
}

// FormatCurrency renders a monetary value with the locale's conventions for
// separators AND the currency's symbol + fraction digits.
func FormatCurrency(locale string, v interface{}, code string) string {
	f, ok := toFloat(v)
	if !ok {
		return fmt.Sprint(v)
	}
	tag, err := language.Parse(locale)
	if err != nil {
		tag = language.AmericanEnglish
	}
	unit, err := currency.ParseISO(strings.ToUpper(code))
	if err != nil {
		unit = currency.USD
	}
	p := message.NewPrinter(tag)
	return p.Sprintf("%v", currency.Symbol(unit.Amount(f)))
}

// FormatDate parses a date-ish string and formats it using the supplied Go
// layout. For locale-aware rendering, layouts can include `Monday` / `January`
// / short forms and we substitute the locale's names.
//
// For now this is a thin wrapper around time.Format — the supplied layout
// remains authoritative, so authors opt into locale-aware output by passing a
// non-English layout or by relying on `t` for fixed day/month labels.
func FormatDate(locale string, v interface{}, layout string) string {
	s := fmt.Sprint(v)
	t, err := parseDateLoose(s)
	if err != nil {
		return s
	}
	if layout == "" {
		// Locale-aware sensible default: "Jan 2, 2006" equivalent.
		layout = "January 2, 2006"
	}
	return translateDateLabels(locale, t.Format(layout))
}

// translateDateLabels replaces English weekday/month names with the locale's
// equivalents. Falls back to English if x/text doesn't have a translation.
func translateDateLabels(locale string, formatted string) string {
	tag, err := language.Parse(locale)
	if err != nil {
		return formatted
	}
	dict := weekdayMonthMap(tag)
	for en, local := range dict {
		if strings.Contains(formatted, en) {
			formatted = strings.ReplaceAll(formatted, en, local)
		}
	}
	return formatted
}

// weekdayMonthMap returns an English→localized map for common names. We keep a
// small, pragmatic map instead of reaching for a full CLDR data pack.
func weekdayMonthMap(tag language.Tag) map[string]string {
	// Seven locales that cover the vast majority of B2B doc output. Authors who
	// need more can translate the fixed labels (e.g. "Bill to") via translation
	// sets, which is the more robust path anyway.
	locale := tag.String()
	switch strings.ToLower(locale[:min(2, len(locale))]) {
	case "es":
		return es
	case "fr":
		return fr
	case "de":
		return de
	case "pt":
		return pt
	case "it":
		return it
	case "ja":
		return ja
	case "zh":
		return zh
	}
	return nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var es = map[string]string{
	"Monday": "lunes", "Tuesday": "martes", "Wednesday": "miércoles",
	"Thursday": "jueves", "Friday": "viernes", "Saturday": "sábado", "Sunday": "domingo",
	"Mon": "lun", "Tue": "mar", "Wed": "mié", "Thu": "jue", "Fri": "vie", "Sat": "sáb", "Sun": "dom",
	"January": "enero", "February": "febrero", "March": "marzo", "April": "abril",
	"May": "mayo", "June": "junio", "July": "julio", "August": "agosto",
	"September": "septiembre", "October": "octubre", "November": "noviembre", "December": "diciembre",
	"Jan": "ene", "Feb": "feb", "Mar": "mar", "Apr": "abr", "Jun": "jun", "Jul": "jul",
	"Aug": "ago", "Sep": "sep", "Oct": "oct", "Nov": "nov", "Dec": "dic",
}
var fr = map[string]string{
	"Monday": "lundi", "Tuesday": "mardi", "Wednesday": "mercredi",
	"Thursday": "jeudi", "Friday": "vendredi", "Saturday": "samedi", "Sunday": "dimanche",
	"Mon": "lun.", "Tue": "mar.", "Wed": "mer.", "Thu": "jeu.", "Fri": "ven.", "Sat": "sam.", "Sun": "dim.",
	"January": "janvier", "February": "février", "March": "mars", "April": "avril",
	"May": "mai", "June": "juin", "July": "juillet", "August": "août",
	"September": "septembre", "October": "octobre", "November": "novembre", "December": "décembre",
	"Jan": "janv.", "Feb": "févr.", "Mar": "mars", "Apr": "avr.", "Jun": "juin", "Jul": "juil.",
	"Aug": "août", "Sep": "sept.", "Oct": "oct.", "Nov": "nov.", "Dec": "déc.",
}
var de = map[string]string{
	"Monday": "Montag", "Tuesday": "Dienstag", "Wednesday": "Mittwoch",
	"Thursday": "Donnerstag", "Friday": "Freitag", "Saturday": "Samstag", "Sunday": "Sonntag",
	"Mon": "Mo", "Tue": "Di", "Wed": "Mi", "Thu": "Do", "Fri": "Fr", "Sat": "Sa", "Sun": "So",
	"January": "Januar", "February": "Februar", "March": "März", "April": "April",
	"May": "Mai", "June": "Juni", "July": "Juli", "August": "August",
	"September": "September", "October": "Oktober", "November": "November", "December": "Dezember",
	"Jan": "Jan", "Feb": "Feb", "Mar": "Mär", "Apr": "Apr", "Jun": "Jun", "Jul": "Jul",
	"Aug": "Aug", "Sep": "Sep", "Oct": "Okt", "Nov": "Nov", "Dec": "Dez",
}
var pt = map[string]string{
	"Monday": "segunda-feira", "Tuesday": "terça-feira", "Wednesday": "quarta-feira",
	"Thursday": "quinta-feira", "Friday": "sexta-feira", "Saturday": "sábado", "Sunday": "domingo",
	"Mon": "seg", "Tue": "ter", "Wed": "qua", "Thu": "qui", "Fri": "sex", "Sat": "sáb", "Sun": "dom",
	"January": "janeiro", "February": "fevereiro", "March": "março", "April": "abril",
	"May": "maio", "June": "junho", "July": "julho", "August": "agosto",
	"September": "setembro", "October": "outubro", "November": "novembro", "December": "dezembro",
	"Jan": "jan", "Feb": "fev", "Mar": "mar", "Apr": "abr", "Jun": "jun", "Jul": "jul",
	"Aug": "ago", "Sep": "set", "Oct": "out", "Nov": "nov", "Dec": "dez",
}
var it = map[string]string{
	"Monday": "lunedì", "Tuesday": "martedì", "Wednesday": "mercoledì",
	"Thursday": "giovedì", "Friday": "venerdì", "Saturday": "sabato", "Sunday": "domenica",
	"Mon": "lun", "Tue": "mar", "Wed": "mer", "Thu": "gio", "Fri": "ven", "Sat": "sab", "Sun": "dom",
	"January": "gennaio", "February": "febbraio", "March": "marzo", "April": "aprile",
	"May": "maggio", "June": "giugno", "July": "luglio", "August": "agosto",
	"September": "settembre", "October": "ottobre", "November": "novembre", "December": "dicembre",
	"Jan": "gen", "Feb": "feb", "Mar": "mar", "Apr": "apr", "Jun": "giu", "Jul": "lug",
	"Aug": "ago", "Sep": "set", "Oct": "ott", "Nov": "nov", "Dec": "dic",
}
var ja = map[string]string{
	"Monday": "月曜日", "Tuesday": "火曜日", "Wednesday": "水曜日",
	"Thursday": "木曜日", "Friday": "金曜日", "Saturday": "土曜日", "Sunday": "日曜日",
	"Mon": "月", "Tue": "火", "Wed": "水", "Thu": "木", "Fri": "金", "Sat": "土", "Sun": "日",
	"January": "1月", "February": "2月", "March": "3月", "April": "4月",
	"May": "5月", "June": "6月", "July": "7月", "August": "8月",
	"September": "9月", "October": "10月", "November": "11月", "December": "12月",
}
var zh = map[string]string{
	"Monday": "星期一", "Tuesday": "星期二", "Wednesday": "星期三",
	"Thursday": "星期四", "Friday": "星期五", "Saturday": "星期六", "Sunday": "星期日",
	"Mon": "周一", "Tue": "周二", "Wed": "周三", "Thu": "周四", "Fri": "周五", "Sat": "周六", "Sun": "周日",
	"January": "一月", "February": "二月", "March": "三月", "April": "四月",
	"May": "五月", "June": "六月", "July": "七月", "August": "八月",
	"September": "九月", "October": "十月", "November": "十一月", "December": "十二月",
}

// -- utilities -------------------------------------------------------------

func parseDateLoose(s string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339,
		"2006-01-02T15:04:05Z",
		"2006-01-02",
		"01/02/2006",
		"02/01/2006",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized date: %q", s)
}

func toFloat(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case string:
		var f float64
		if _, err := fmt.Sscanf(x, "%f", &f); err == nil {
			return f, true
		}
	}
	return 0, false
}
