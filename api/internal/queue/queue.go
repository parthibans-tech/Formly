// Package queue wraps Asynq with typed task payloads and shared config.
package queue

import (
	"encoding/json"
	"os"

	"github.com/hibiken/asynq"
)

const (
	TaskGenerateOne    = "generate:one"
	TaskGenerateBatch  = "generate:batch"
	TaskWebhookDeliver = "webhook:deliver"
)

// RedisAddr returns the Redis connection string (from env, default to localhost).
func RedisAddr() string {
	if v := os.Getenv("REDIS_ADDR"); v != "" {
		return v
	}
	return "localhost:6379"
}

func ClientOpt() asynq.RedisClientOpt {
	return asynq.RedisClientOpt{Addr: RedisAddr()}
}

// GenerateOnePayload describes a single async generation job.
// The job_id column in generation_jobs is the source of truth for status.
type GenerateOnePayload struct {
	JobID      string                 `json:"jobId"`
	OrgID      string                 `json:"orgId"`
	UserID     string                 `json:"userId"`
	TemplateID string                 `json:"templateId"`
	Data       map[string]interface{} `json:"data"`
	Flatten    bool                   `json:"flatten"`
}

// GenerateBatchPayload references a previously-uploaded tabular input via
// MinIO key. `Kind` describes the format (csv | xlsx | tsv) so the worker
// knows how to parse it.
type GenerateBatchPayload struct {
	JobID      string `json:"jobId"`
	OrgID      string `json:"orgId"`
	UserID     string `json:"userId"`
	TemplateID string `json:"templateId"`
	CSVKey     string `json:"csvKey"`
	Kind       string `json:"kind,omitempty"` // csv (default) | xlsx | tsv
	OutputName string `json:"outputName"`
}

func NewGenerateOne(p GenerateOnePayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskGenerateOne, b, asynq.MaxRetry(3)), nil
}

func NewGenerateBatch(p GenerateBatchPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	return asynq.NewTask(TaskGenerateBatch, b, asynq.MaxRetry(1)), nil
}

// WebhookDeliverPayload describes a single outgoing webhook attempt. The task
// handler signs the body, POSTs it, records the result, and asynq's MaxRetry
// mechanism drives exponential backoff on non-2xx responses.
type WebhookDeliverPayload struct {
	WebhookID string          `json:"webhookId"`
	Event     string          `json:"event"`
	Body      json.RawMessage `json:"body"`
}

func NewWebhookDeliver(p WebhookDeliverPayload) (*asynq.Task, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	// 5 retries with asynq's default exponential backoff (≈ 1m, 5m, 30m, 2h, 12h).
	return asynq.NewTask(TaskWebhookDeliver, b, asynq.MaxRetry(5)), nil
}
