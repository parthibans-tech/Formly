package metrics

import (
	"context"
	"time"

	"github.com/hibiken/asynq"
)

// AsynqMiddleware returns an asynq.MiddlewareFunc that records the
// three queue series declared on the registry. It mirrors the chi
// HTTP middleware: count + duration + in-flight, with `result` ∈
// {success, failed} so the on-call can build an error-rate alert
// using the same PromQL shape they use for HTTP.
//
// Wire it once on the worker mux:
//
//	mux := asynq.NewServeMux()
//	mux.Use(metricsReg.AsynqMiddleware())
//	h.Register(mux)
//
// The asynq library already invokes middleware in registration
// order; mounting metrics first means it observes the canonical
// outcome (i.e. after retries / panics — asynq turns a panic into
// an error before the middleware return path).
//
// Cardinality: `task` is asynq's task type (a static const from
// internal/queue), and `queue` is the asynq queue name (currently
// only "default"). Neither is user-supplied, so this is safe.
func (r *Registry) AsynqMiddleware() asynq.MiddlewareFunc {
	if r == nil {
		// Returning a no-op middleware lets callers wire the same
		// metrics package on a worker that didn't construct a
		// Registry — handy in unit tests and in dev when
		// observability is intentionally off.
		return func(h asynq.Handler) asynq.Handler { return h }
	}
	return func(next asynq.Handler) asynq.Handler {
		return asynq.HandlerFunc(func(ctx context.Context, t *asynq.Task) error {
			queue, _ := asynq.GetQueueName(ctx)
			if queue == "" {
				queue = "unknown"
			}
			task := t.Type()
			if task == "" {
				task = "unknown"
			}

			r.QueueInFlight.WithLabelValues(queue).Inc()
			start := time.Now()
			err := next.ProcessTask(ctx, t)
			dur := time.Since(start).Seconds()
			r.QueueInFlight.WithLabelValues(queue).Dec()

			result := "success"
			if err != nil {
				result = "failed"
			}
			r.QueueTasks.WithLabelValues(queue, task, result).Inc()
			r.QueueDuration.WithLabelValues(queue, task).Observe(dur)
			return err
		})
	}
}
