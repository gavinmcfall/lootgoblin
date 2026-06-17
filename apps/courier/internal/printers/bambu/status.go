package bambu

// status.go — Bambu LAN MQTT status subscriber for the lootgoblin Courier.
//
// Part 2 of the Bambu LAN protocol port (V2-006c C-C).
//
// Protocol facts:
//   - Subscribe to device/<serial>/report on mqtts://<ip>:<mqttPort>.
//   - Messages arrive as incremental {print:{…}} or full-snapshot
//     {pushing:{pushall:{…}}} frames.  We read only the top-level "print" key
//     (Bambu wraps full snapshots with the same inner shape as incremental
//     updates).
//   - State is carried in print.gcode_state (IDLE/PREPARE/RUNNING/PAUSE/
//     FINISH/FAILED).  PAUSE→IDLE without an intervening FINISH = operator
//     cancelled.
//   - Progress: print.mc_percent (0..100), print.layer_num /
//     print.total_layer_num, print.mc_remaining_time (seconds).
//   - AMS per-slot remain%: print.ams.ams[].tray[].remain (0..100).
//     On terminal events (completed / firmware_error) we surface this as
//     MeasuredConsumptionSlot with grams=0 and remain_percent set.
//     We do NOT compute grams — the server refines remain%→grams in Phase A.
//   - HMS alerts: print.hms[].attr + code + level → one 'warning' per entry.
//   - print.print_error (uint32) → errorCode on firmware_error events.
//
// The MqttClient interface (defined in mqtt.go) is extended here with a
// Subscribe method.  Tests inject a fakeMqttStatusClient that drives recorded
// payloads through the registered handler.
//
// Porting source: apps/server/src/forge/status/subscribers/bambu.ts

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"
	"github.com/gavinmcfall/lootgoblin/courier/internal/central"
	"github.com/gavinmcfall/lootgoblin/courier/internal/printers"
)

// ---------------------------------------------------------------------------
// Extended MQTT interface — adds Subscribe (status path only)
// ---------------------------------------------------------------------------

// SubscribingMqttClient extends MqttClient with a subscribe method needed by
// the status subscriber.  The production paho.Client satisfies both MqttClient
// and SubscribingMqttClient.  Tests inject a fake that only needs Subscribe.
type SubscribingMqttClient interface {
	MqttClient
	// Subscribe registers a message handler for the given topic at QoS 0.
	// The paho.MessageHandler callback receives (client, message).
	Subscribe(topic string, qos byte, callback paho.MessageHandler) paho.Token
}

// MqttStatusClientFactory creates a SubscribingMqttClient for the status path.
// A nil factory defaults to DefaultMqttStatusClientFactory.
type MqttStatusClientFactory func(brokerURL string, opts mqttOpts) SubscribingMqttClient

// DefaultMqttStatusClientFactory creates a real paho client that supports both
// publish and subscribe.  paho.NewClient returns a paho.Client which
// implements both interfaces.
func DefaultMqttStatusClientFactory(brokerURL string, opts mqttOpts) SubscribingMqttClient {
	o := paho.NewClientOptions()
	o.AddBroker(brokerURL)
	o.SetClientID(opts.ClientID)
	o.SetUsername(opts.Username)
	o.SetPassword(opts.Password)
	o.SetTLSConfig(opts.TLSConfig)
	o.SetConnectRetry(false)
	o.SetAutoReconnect(false)
	return paho.NewClient(o)
}

// ---------------------------------------------------------------------------
// Bambu pushall / report JSON shapes (loose — firmware adds fields freely)
// ---------------------------------------------------------------------------

type bambuTrayPayload struct {
	ID     *string  `json:"id"`
	Remain *float64 `json:"remain"`
}

type bambuAmsUnit struct {
	ID   *string            `json:"id"`
	Tray []bambuTrayPayload `json:"tray"`
}

type bambuAmsBlock struct {
	Ams []bambuAmsUnit `json:"ams"`
}

type bambuHmsEntry struct {
	Attr  *uint32  `json:"attr"`
	Code  *uint32  `json:"code"`
	Level *float64 `json:"level"`
}

type bambuPrintPayload struct {
	GcodeState      *string         `json:"gcode_state"`
	McPercent       *float64        `json:"mc_percent"`
	McRemainingTime *float64        `json:"mc_remaining_time"` // seconds
	LayerNum        *int            `json:"layer_num"`
	TotalLayerNum   *int            `json:"total_layer_num"`
	SubtaskName     *string         `json:"subtask_name"`
	Ams             *bambuAmsBlock  `json:"ams"`
	PrintError      *uint32         `json:"print_error"`
	Hms             []bambuHmsEntry `json:"hms"`
}

// bambuReportParsed is a parallel struct used only for typed field extraction.
type bambuReportParsed struct {
	Print *bambuPrintPayload `json:"print"`
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — fully unit-testable)
// ---------------------------------------------------------------------------

// statusEventKind is an alias to avoid importing a separate package just for
// the constant strings.
type bambuStatusKind string

const (
	bambuKindStarted       bambuStatusKind = "started"
	bambuKindProgress      bambuStatusKind = "progress"
	bambuKindPaused        bambuStatusKind = "paused"
	bambuKindCompleted     bambuStatusKind = "completed"
	bambuKindCancelled     bambuStatusKind = "cancelled"
	bambuKindFirmwareError bambuStatusKind = "firmware_error"
	bambuKindWarning       bambuStatusKind = "warning"
)

// mapBambuState maps a Bambu gcode_state enum to a unified status kind.
// Returns ("", false) for states that should be silently ignored (IDLE).
// Ported verbatim from mapBambuState() in bambu.ts.
func mapBambuState(state string) (bambuStatusKind, bool) {
	switch state {
	case "IDLE":
		return "", false
	case "PREPARE":
		return bambuKindStarted, true
	case "RUNNING":
		return bambuKindProgress, true
	case "PAUSE":
		return bambuKindPaused, true
	case "FINISH":
		return bambuKindCompleted, true
	case "FAILED":
		return bambuKindFirmwareError, true // CF-5a: firmware fault, not operator cancel
	default:
		return "", false
	}
}

// hmsLevelToSeverity maps a Bambu HMS level float to a severity tier.
// Ported from hmsLevelToSeverity() in bambu.ts.
func hmsLevelToSeverity(level float64) string {
	tier := int(math.Floor(level))
	if tier <= 0 {
		return "info"
	}
	if tier == 1 {
		return "warning"
	}
	return "error"
}

// formatHmsCode formats attr+code as XXXX-XXXX-XXXX-XXXX (hex, zero-padded).
// Ported from formatHmsCode() in bambu.ts.
func formatHmsCode(attr, code uint32) string {
	hi := fmt.Sprintf("%08X", attr)
	lo := fmt.Sprintf("%08X", code)
	return fmt.Sprintf("%s-%s-%s-%s", hi[:4], hi[4:], lo[:4], lo[4:])
}

// extractAmsSlots flattens ams.ams[*].tray[*] into per-slot consumption entries.
// grams=0 because Bambu does not expose spool weight; remain_percent is the raw
// tray percentage.  Ported from extractAmsSlots() in bambu.ts.
func extractAmsSlots(ams *bambuAmsBlock) []central.MeasuredConsumptionSlot {
	if ams == nil {
		return nil
	}
	var slots []central.MeasuredConsumptionSlot
	for unitIdx, unit := range ams.Ams {
		for _, tray := range unit.Tray {
			// Parse tray ID (string "0".."3").
			trayID := 0
			if tray.ID != nil {
				var parsed int
				if _, err := fmt.Sscanf(*tray.ID, "%d", &parsed); err == nil {
					trayID = parsed
				}
			}
			slotIndex := unitIdx*4 + trayID
			slot := central.MeasuredConsumptionSlot{
				SlotIndex: slotIndex,
				Grams:     0,
			}
			if tray.Remain != nil {
				rp := *tray.Remain
				slot.RemainPercent = &rp
			}
			slots = append(slots, slot)
		}
	}
	return slots
}

// bambuIntent is a pure-value description of one report to send to central.
type bambuIntent struct {
	// status-event fields
	kind         bambuStatusKind
	remoteJobRef string
	progressPct  *float64
	layerNum     *int
	totalLayers  *int
	remainingMin *float64
	errorCode    string
	severity     string
	// measuredConsumption only on terminal events (completed / firmware_error)
	measuredConsumption []central.MeasuredConsumptionSlot
	rawPayload          any
	occurredAt          time.Time

	// terminal reports
	isCompleted bool
	isFailed    bool
	failReason  string
	failDetails string
}

// buildBambuIntents parses a decoded pushall envelope and returns zero or more
// intents.  It is the pure core ported from the onMqttMessage closure in
// bambu.ts (pure fields extracted — no side effects, no callbacks).
//
// lastGcodeState is the caller-owned PAUSE-tracking variable (passed by
// pointer so the caller can update it).
func buildBambuIntents(
	rawEnvelope any,
	parsedPrint *bambuPrintPayload,
	lastGcodeState *string,
	now time.Time,
) []bambuIntent {
	if parsedPrint == nil {
		return nil
	}

	remoteJobRef := ""
	if parsedPrint.SubtaskName != nil {
		remoteJobRef = *parsedPrint.SubtaskName
	}

	currentState := ""
	if parsedPrint.GcodeState != nil {
		currentState = *parsedPrint.GcodeState
	}

	var intents []bambuIntent

	// V2-005f-CF-5a: operator-cancel detection.
	// PAUSE → IDLE without an intervening FINISH = operator pressed STOP.
	if *lastGcodeState == "PAUSE" && currentState == "IDLE" {
		intents = append(intents, bambuIntent{
			kind:         bambuKindCancelled,
			remoteJobRef: remoteJobRef,
			rawPayload:   rawEnvelope,
			occurredAt:   now,
			// operator cancel → post failed{rejected, cancelled} terminal
			isFailed:    true,
			failReason:  "rejected",
			failDetails: "cancelled",
		})
	}

	// Update caller-owned tracking state.
	*lastGcodeState = currentState

	kind, ok := mapBambuState(currentState)
	if ok {
		intent := bambuIntent{
			kind:         kind,
			remoteJobRef: remoteJobRef,
			rawPayload:   rawEnvelope,
			occurredAt:   now,
		}

		// Progress fields.
		if parsedPrint.McPercent != nil {
			pct := *parsedPrint.McPercent
			intent.progressPct = &pct
		}
		if parsedPrint.McRemainingTime != nil {
			rem := math.Round(*parsedPrint.McRemainingTime / 60.0)
			intent.remainingMin = &rem
		}
		if parsedPrint.LayerNum != nil {
			ln := *parsedPrint.LayerNum
			intent.layerNum = &ln
		}
		if parsedPrint.TotalLayerNum != nil {
			tl := *parsedPrint.TotalLayerNum
			intent.totalLayers = &tl
		}

		// error code on firmware_error (from print_error).
		if kind == bambuKindFirmwareError && parsedPrint.PrintError != nil && *parsedPrint.PrintError != 0 {
			intent.errorCode = fmt.Sprintf("%d", *parsedPrint.PrintError)
		}

		// Per-slot AMS remain% on terminal events only.
		// NOTE: completed has NO materials_used — remain% in raw_payload only.
		// The server's Phase-A estimate stands; T_dcf11 back-calculates later.
		if kind == bambuKindCompleted || kind == bambuKindFirmwareError {
			slots := extractAmsSlots(parsedPrint.Ams)
			if len(slots) > 0 {
				intent.measuredConsumption = slots
			}
		}

		// Terminal reports (mirrors moonraker's sendIntent pattern).
		if kind == bambuKindCompleted {
			intent.isCompleted = true
		} else if kind == bambuKindFirmwareError {
			details := intent.errorCode
			if details == "" {
				details = "firmware error"
			}
			intent.isFailed = true
			intent.failReason = "rejected"
			intent.failDetails = details
		}

		intents = append(intents, intent)
	}

	// HMS warning events — one per entry per pushall.
	// T_a6 downstream deduplicates repeating codes.
	for _, hms := range parsedPrint.Hms {
		if hms.Attr == nil || hms.Code == nil {
			continue
		}
		level := 0.0
		if hms.Level != nil {
			level = *hms.Level
		}
		intents = append(intents, bambuIntent{
			kind:         bambuKindWarning,
			remoteJobRef: remoteJobRef,
			rawPayload:   hms,
			occurredAt:   now,
			errorCode:    formatHmsCode(*hms.Attr, *hms.Code),
			severity:     hmsLevelToSeverity(level),
		})
	}

	return intents
}

// sendBambuIntent converts a bambuIntent to central.StatusReport calls.
func sendBambuIntent(ctx context.Context, reporter printers.Reporter, jobID string, intent bambuIntent, log *slog.Logger) {
	// Status-event report.
	evt := central.StatusEventPayload{
		Kind:         string(intent.kind),
		RemoteJobRef: intent.remoteJobRef,
		RawPayload:   intent.rawPayload,
		OccurredAt:   intent.occurredAt.UTC().Format(time.RFC3339),
	}
	if intent.progressPct != nil {
		pct := *intent.progressPct
		evt.ProgressPct = &pct
	}
	if intent.layerNum != nil {
		ln := *intent.layerNum
		evt.LayerNum = &ln
	}
	if intent.totalLayers != nil {
		tl := *intent.totalLayers
		evt.TotalLayers = &tl
	}
	if intent.remainingMin != nil {
		rem := *intent.remainingMin
		evt.RemainingMin = &rem
	}
	if intent.errorCode != "" {
		evt.ErrorCode = intent.errorCode
	}
	if intent.severity != "" {
		evt.Severity = intent.severity
	}
	if len(intent.measuredConsumption) > 0 {
		evt.MeasuredConsumption = intent.measuredConsumption
	}

	if err := reporter.ReportStatus(ctx, central.StatusEventReport(jobID, evt)); err != nil {
		log.Warn("bambu status: report status-event failed", "job_id", jobID, "err", err)
	}

	// Terminal reports.
	if intent.isCompleted {
		// No materials_used here — server's Phase-A estimate stands.
		// remain% is already in measured_consumption on the status-event above.
		if err := reporter.ReportStatus(ctx, central.CompletedReport(jobID, nil)); err != nil {
			log.Warn("bambu status: report completed failed", "job_id", jobID, "err", err)
		}
	} else if intent.isFailed {
		if err := reporter.ReportStatus(ctx, central.FailedReport(jobID, intent.failReason, intent.failDetails)); err != nil {
			log.Warn("bambu status: report failed failed", "job_id", jobID, "err", err)
		}
	}
}

// ---------------------------------------------------------------------------
// Subscribe — main entry point (satisfies printers.StatusWatcher contract)
// ---------------------------------------------------------------------------

// Subscribe connects to the Bambu MQTT broker, subscribes to
// device/<serial>/report, and relays StatusEvents to reporter until ctx is
// cancelled or the connection is dropped.
//
// A connection/read drop returns an error — the orchestrator handles reconnect.
// We NEVER post a failed report due to a status-feed drop ("sent ≠ failed").
//
// factory may be nil; DefaultMqttStatusClientFactory is used in that case.
func Subscribe(
	ctx context.Context,
	cfg ConnectionConfig,
	cred Credential,
	jobID string,
	reporter printers.Reporter,
	factory MqttStatusClientFactory,
	log *slog.Logger,
) error {
	if log == nil {
		log = slog.Default()
	}
	if factory == nil {
		factory = DefaultMqttStatusClientFactory
	}

	brokerURL := fmt.Sprintf("mqtts://%s:%d", cfg.IP, cfg.MqttPort)
	clientID := "lootgoblin-status-" + randomHex(8)
	tlsCfg := &tls.Config{
		//nolint:gosec // self-signed LAN cert; trust boundary is the LAN
		InsecureSkipVerify: true,
	}

	client := factory(brokerURL, mqttOpts{
		Username:  BambuLanUsername,
		Password:  cred.AccessCode,
		ClientID:  clientID,
		TLSConfig: tlsCfg,
	})

	// Connect.
	connectToken := client.Connect()
	connectTimeout := time.Duration(DefaultBambuTimeoutMs) * time.Millisecond
	if !connectToken.WaitTimeout(connectTimeout) {
		client.Disconnect(250)
		return fmt.Errorf("bambu status: MQTT connect timed out")
	}
	if err := connectToken.Error(); err != nil {
		client.Disconnect(250)
		return fmt.Errorf("bambu status: MQTT connect: %w", err)
	}
	defer client.Disconnect(250)

	topic := fmt.Sprintf("device/%s/report", cred.Serial)

	// messageCh is the bridge between the paho callback goroutine and the
	// select-based read loop below.
	messageCh := make(chan []byte, 256)

	// Subscribe with a handler that drops payloads into messageCh.
	subToken := client.Subscribe(topic, 0, func(_ paho.Client, msg paho.Message) {
		if msg.Topic() != topic {
			return
		}
		payload := make([]byte, len(msg.Payload()))
		copy(payload, msg.Payload())
		select {
		case messageCh <- payload:
		default:
			// Drop if buffer full — progress events are expendable.
		}
	})
	subToken.Wait()
	if err := subToken.Error(); err != nil {
		return fmt.Errorf("bambu status: MQTT subscribe: %w", err)
	}

	log.Info("bambu status: subscribed",
		"broker", brokerURL,
		"topic", topic,
		"job_id", jobID,
	)

	// lastGcodeState tracks the previous pushall state for PAUSE→IDLE detection.
	lastGcodeState := ""

	for {
		select {
		case <-ctx.Done():
			log.Info("bambu status: context cancelled, stopping", "job_id", jobID)
			return ctx.Err()

		case raw := <-messageCh:
			intents := decodeBambuMessage(raw, &lastGcodeState, log)
			for _, intent := range intents {
				sendBambuIntent(ctx, reporter, jobID, intent, log)
			}
		}
	}
}

// decodeBambuMessage parses one raw MQTT payload and returns zero or more
// bambuIntents.  lastGcodeState is updated in place for PAUSE→IDLE detection.
func decodeBambuMessage(raw []byte, lastGcodeState *string, log *slog.Logger) []bambuIntent {
	if log == nil {
		log = slog.Default()
	}

	// Decode as generic any (for raw_payload preservation).
	var rawEnvelope any
	if err := json.Unmarshal(raw, &rawEnvelope); err != nil {
		log.Warn("bambu status: unparse-able payload", "err", err)
		return nil
	}

	// Decode as typed struct (for field extraction).
	var parsed bambuReportParsed
	if err := json.Unmarshal(raw, &parsed); err != nil {
		log.Warn("bambu status: typed decode failed", "err", err)
		return nil
	}

	if parsed.Print == nil {
		// e.g. pushing.pushall wrappers without a top-level "print" key.
		return nil
	}

	return buildBambuIntents(rawEnvelope, parsed.Print, lastGcodeState, time.Now())
}
