// Package central provides a typed HTTP client for the lootgoblin central
// instance API and the data types that model the JSON contract.
package central

import "encoding/json"

// ---------------------------------------------------------------------------
// GET /api/v1/instance
// ---------------------------------------------------------------------------

// Instance is the identity triple returned by the unauthenticated instance
// endpoint.
type Instance struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
	Name      string `json:"name"`
}

// ---------------------------------------------------------------------------
// POST /api/v1/couriers/pair
// ---------------------------------------------------------------------------

// PairResult is the successful response from the pair endpoint.
type PairResult struct {
	APIKey        string `json:"api_key"`
	AgentID       string `json:"agent_id"`
	InstanceID    string `json:"instance_id"`
	ServerVersion string `json:"server_version"`
}

// ---------------------------------------------------------------------------
// POST /api/v1/couriers/heartbeat
// ---------------------------------------------------------------------------

// PrinterEntry is one element in the heartbeat printer list.
type PrinterEntry struct {
	PrinterID       string `json:"printer_id"`
	ReachableStatus string `json:"reachable_status"`
	Detail          string `json:"detail,omitempty"`
}

// HeartbeatRequest is the body sent to the heartbeat endpoint.
type HeartbeatRequest struct {
	CourierVersion string         `json:"courier_version"`
	Printers       []PrinterEntry `json:"printers,omitempty"`
}

// HeartbeatResult is the successful response from the heartbeat endpoint.
type HeartbeatResult struct {
	OK                       bool   `json:"ok"`
	ServerVersion            string `json:"server_version"`
	HeartbeatIntervalSeconds int    `json:"heartbeat_interval_seconds"`
	Warning                  string `json:"warning,omitempty"`
}

// ---------------------------------------------------------------------------
// POST /api/v1/dispatch/claim
// ---------------------------------------------------------------------------

// ClaimJob is the job metadata inside a ClaimBundle.
type ClaimJob struct {
	ID         string `json:"id"`
	TargetKind string `json:"target_kind"`
	TargetID   string `json:"target_id"`
	LootID     string `json:"loot_id"`
	OwnerID    string `json:"owner_id"`
}

// ClaimPrinter is the printer record inside a ClaimBundle.
// ConnectionConfig is kept as raw JSON so B6/B7 (Moonraker) can unmarshal it
// into protocol-specific structs without the client needing to know the shape.
type ClaimPrinter struct {
	ID               string          `json:"id"`
	Kind             string          `json:"kind"`
	ConnectionConfig json.RawMessage `json:"connection_config"`
}

// ClaimCredential is the credential record inside a ClaimBundle.
// Payload is kept as raw JSON for the same reason as ConnectionConfig.
type ClaimCredential struct {
	Kind    string          `json:"kind"`
	Payload json.RawMessage `json:"payload"`
}

// ClaimArtifact is the file-metadata record inside a ClaimBundle.
type ClaimArtifact struct {
	JobID       string `json:"job_id"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
	MimeType    string `json:"mime_type"`
	DownloadURL string `json:"download_url"`
}

// ClaimBundle is the full execution payload returned when a job is claimed.
// Printer, Credential, and Artifact may be nil for non-printer target kinds.
type ClaimBundle struct {
	Job        ClaimJob         `json:"job"`
	Printer    *ClaimPrinter    `json:"printer"`
	Credential *ClaimCredential `json:"credential"`
	Artifact   *ClaimArtifact   `json:"artifact"`
}

// ---------------------------------------------------------------------------
// POST /api/v1/dispatch/status — discriminated union on "phase"
// ---------------------------------------------------------------------------

// MeasuredConsumptionSlot is one slot entry inside a status-event or completed
// report.
type MeasuredConsumptionSlot struct {
	SlotIndex     int      `json:"slot_index"`
	Grams         float64  `json:"grams"`
	VolumeMl      *float64 `json:"volume_ml,omitempty"`
	RemainPercent *float64 `json:"remain_percent,omitempty"`
}

// StatusEventPayload is the event object inside a status-event phase report.
type StatusEventPayload struct {
	Kind                string                    `json:"kind"`
	RemoteJobRef        string                    `json:"remote_job_ref"`
	ProgressPct         *float64                  `json:"progress_pct,omitempty"`
	LayerNum            *int                      `json:"layer_num,omitempty"`
	TotalLayers         *int                      `json:"total_layers,omitempty"`
	RemainingMin        *float64                  `json:"remaining_min,omitempty"`
	MeasuredConsumption []MeasuredConsumptionSlot `json:"measured_consumption,omitempty"`
	ErrorCode           string                    `json:"error_code,omitempty"`
	ErrorMessage        string                    `json:"error_message,omitempty"`
	Severity            string                    `json:"severity,omitempty"`
	RawPayload          any                       `json:"raw_payload,omitempty"`
	OccurredAt          string                    `json:"occurred_at,omitempty"`
}

// MaterialsUsedSlot is one entry in the completed phase materials_used list.
type MaterialsUsedSlot struct {
	SlotIndex     int     `json:"slot_index"`
	MaterialID    string  `json:"material_id"`
	MeasuredGrams float64 `json:"measured_grams"`
}

// StatusReport is the body sent to POST /api/v1/dispatch/status.
// Use the typed constructor functions (DispatchedReport, FailedReport,
// StatusEventReport, CompletedReport) rather than constructing this directly.
type StatusReport struct {
	Phase          string              `json:"phase"`
	JobID          string              `json:"job_id"`
	RemoteFilename string              `json:"remote_filename,omitempty"`
	Reason         string              `json:"reason,omitempty"`
	Details        string              `json:"details,omitempty"`
	Event          *StatusEventPayload `json:"event,omitempty"`
	MaterialsUsed  []MaterialsUsedSlot `json:"materials_used,omitempty"`
}

// DispatchedReport builds a StatusReport for the "dispatched" phase.
func DispatchedReport(jobID, remoteFilename string) StatusReport {
	return StatusReport{
		Phase:          "dispatched",
		JobID:          jobID,
		RemoteFilename: remoteFilename,
	}
}

// FailedReport builds a StatusReport for the "failed" phase.
func FailedReport(jobID, reason, details string) StatusReport {
	return StatusReport{
		Phase:   "failed",
		JobID:   jobID,
		Reason:  reason,
		Details: details,
	}
}

// StatusEventReport builds a StatusReport for the "status-event" phase.
func StatusEventReport(jobID string, event StatusEventPayload) StatusReport {
	return StatusReport{
		Phase: "status-event",
		JobID: jobID,
		Event: &event,
	}
}

// CompletedReport builds a StatusReport for the "completed" phase.
func CompletedReport(jobID string, materialsUsed []MaterialsUsedSlot) StatusReport {
	return StatusReport{
		Phase:         "completed",
		JobID:         jobID,
		MaterialsUsed: materialsUsed,
	}
}
