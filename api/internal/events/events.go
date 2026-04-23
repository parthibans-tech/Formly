// Package events is a tiny in-process pub/sub used to decouple emitters
// (generate runner, share handler, file uploads, template updates) from
// receivers (webhook dispatcher). Handlers run in goroutines and must not
// block the publisher — if the handler fans out to a queue it does so
// without waiting for the delivery to complete.
package events

import (
	"context"
	"sync"
	"time"
)

// Canonical event names. Keep these in sync with the UI's event picker.
const (
	GenerateCompleted = "generate.completed"
	GenerateFailed    = "generate.failed"
	ShareAccessed     = "share.accessed"
	TemplateUpdated   = "template.updated"
	FileUploaded      = "file.uploaded"
)

// AllEvents is the curated list exposed to UIs.
var AllEvents = []string{
	GenerateCompleted,
	GenerateFailed,
	ShareAccessed,
	TemplateUpdated,
	FileUploaded,
}

// Event is a typed envelope passed to subscribers.
type Event struct {
	Name      string                 `json:"event"`
	OrgID     string                 `json:"org_id"`
	Payload   map[string]interface{} `json:"data"`
	Timestamp time.Time              `json:"at"`
}

type Handler func(ctx context.Context, e Event)

type Bus struct {
	mu   sync.RWMutex
	subs []Handler
}

// Default is the package-level bus. A single bus is plenty for MVP; if we
// ever need per-tenant isolation we can make this a map[orgID]*Bus.
var Default = &Bus{}

// Subscribe registers a handler. Subscribers never un-subscribe at runtime
// in this codebase — they're set up once during cmd/api startup.
func (b *Bus) Subscribe(h Handler) {
	b.mu.Lock()
	b.subs = append(b.subs, h)
	b.mu.Unlock()
}

// Publish fans out to every subscriber in its own goroutine. Publishers are
// never blocked by slow handlers.
func (b *Bus) Publish(ctx context.Context, name, orgID string, payload map[string]interface{}) {
	ev := Event{
		Name:      name,
		OrgID:     orgID,
		Payload:   payload,
		Timestamp: time.Now(),
	}
	b.mu.RLock()
	subs := append([]Handler(nil), b.subs...)
	b.mu.RUnlock()
	for _, h := range subs {
		go func(fn Handler) {
			defer func() {
				_ = recover() // never let a handler panic take down the server
			}()
			// Hand each handler a fresh context so cancellations in the
			// publisher don't propagate into async delivery.
			fn(context.Background(), ev)
		}(h)
	}
}

// Publish is a convenience on the default bus.
func Publish(ctx context.Context, name, orgID string, payload map[string]interface{}) {
	Default.Publish(ctx, name, orgID, payload)
}

// Subscribe registers on the default bus.
func Subscribe(h Handler) { Default.Subscribe(h) }
