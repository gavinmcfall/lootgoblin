package bambu

// mqtt.go — MQTTS print command dispatch for Bambu LAN printers.
//
// Ports the MQTT section of adapter.ts (V2-005d-b T_db3).
//
// The Bambu LAN MQTT server uses a self-signed device certificate, so we set
// InsecureSkipVerify: true.  The trust boundary is the LAN.
//
// Protocol:
//   - Connect to mqtts://{ip}:{mqttPort} with TLS, username "bblp", password
//     = credential.accessCode, random clientId.
//   - On connect: publish the project_file command JSON to
//     device/{serial}/request at QoS 1.
//   - On MQTT error or timeout: return a normalised failure reason.
//
// The MqttClientFactory interface isolates the real paho.NewClient call so
// that dispatch_test.go can stub the network layer without touching the wire.

import (
	"context"
	"crypto/tls"
	"fmt"
	"regexp"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"
)

// DefaultBambuTimeoutMs is the MQTT connect+publish timeout in milliseconds.
// Matches BAMBU_TIMEOUT_MS in adapter.ts.
const DefaultBambuTimeoutMs = 90_000

// MqttClient is the minimal subset of paho.Client that the dispatch path uses.
// Part 2's status subscriber will also implement this interface for its own
// subscribe calls.
type MqttClient interface {
	// Connect initiates the MQTT connection.  Returns a Token.
	Connect() paho.Token
	// Publish sends a message.  Returns a Token.
	Publish(topic string, qos byte, retained bool, payload any) paho.Token
	// Disconnect closes the connection.
	Disconnect(quiesce uint)
}

// MqttClientFactory creates an MqttClient from a broker URL and options.
// The default implementation wraps paho.NewClient.
type MqttClientFactory func(brokerURL string, opts mqttOpts) MqttClient

// mqttOpts carries the parameters needed to create an MQTT client.
type mqttOpts struct {
	Username  string
	Password  string
	ClientID  string
	TLSConfig *tls.Config
}

// DefaultMqttClientFactory creates a real paho MQTT client.
func DefaultMqttClientFactory(brokerURL string, opts mqttOpts) MqttClient {
	o := paho.NewClientOptions()
	o.AddBroker(brokerURL)
	o.SetClientID(opts.ClientID)
	o.SetUsername(opts.Username)
	o.SetPassword(opts.Password)
	o.SetTLSConfig(opts.TLSConfig)
	// Disable automatic reconnect — dispatch is a one-shot operation.
	o.SetConnectRetry(false)
	o.SetAutoReconnect(false)
	return paho.NewClient(o)
}

// mqttAuthRE matches MQTT auth-rejection error messages.
// Mirrors MQTT_AUTH_RE in adapter.ts.
var mqttAuthRE = regexp.MustCompile(`(?i)not authorized|bad user name|bad username|bad password|connection refused`)

// mqttDispatchResult carries a normalised outcome from PublishPrintCommand.
type mqttDispatchResult struct {
	OK             bool
	RemoteFilename string
	Reason         string // unreachable|auth-failed|timeout|unknown
	Detail         string
}

// PrintCommand is the MQTT payload shape for a Bambu project_file command.
// Populated by Dispatch and exposed here for tests / Part 2 re-use.
type PrintCommand struct {
	Print printPayload `json:"print"`
}

type printPayload struct {
	SequenceID    string `json:"sequence_id"`
	Command       string `json:"command"`
	Param         string `json:"param"`
	ProjectID     string `json:"project_id"`
	ProfileID     string `json:"profile_id"`
	TaskID        string `json:"task_id"`
	SubtaskID     string `json:"subtask_id"`
	SubtaskName   string `json:"subtask_name"`
	URL           string `json:"url"`
	Timelapse     bool   `json:"timelapse"`
	BedType       string `json:"bed_type"`
	BedLevelling  bool   `json:"bed_levelling"`
	FlowCali      bool   `json:"flow_cali"`
	VibrationCali bool   `json:"vibration_cali"`
	LayerInspect  bool   `json:"layer_inspect"`
	UseAms        bool   `json:"use_ams"`
	AmsMapping    []int  `json:"ams_mapping"`
}

// BuildPrintCommand constructs the MQTT project_file command payload that
// should be published to device/{serial}/request.
//
// Exposed so Part 2 / tests can inspect it without going through Dispatch.
func BuildPrintCommand(cfg ConnectionConfig, filename string, ams AmsConfig, useAms bool, amsMapping []int) PrintCommand {
	return PrintCommand{
		Print: printPayload{
			SequenceID:    "0",
			Command:       "project_file",
			Param:         fmt.Sprintf("Metadata/plate_%d.gcode", cfg.PlateIndex),
			ProjectID:     "0",
			ProfileID:     "0",
			TaskID:        "0",
			SubtaskID:     "0",
			SubtaskName:   ams.SubtaskName,
			URL:           fmt.Sprintf("ftp:///cache/%s", filename),
			Timelapse:     cfg.Timelapse,
			BedType:       cfg.BedType,
			BedLevelling:  cfg.BedLevelling,
			FlowCali:      cfg.FlowCalibration,
			VibrationCali: cfg.VibrationCal,
			LayerInspect:  cfg.LayerInspect,
			UseAms:        useAms,
			AmsMapping:    amsMapping,
		},
	}
}

// PublishPrintCommand connects to the Bambu MQTT broker, publishes the
// project_file command JSON, and disconnects.
//
// factory may be nil; DefaultMqttClientFactory is used in that case.
// timeoutMs=0 defaults to DefaultBambuTimeoutMs.
func PublishPrintCommand(
	ctx context.Context,
	cfg ConnectionConfig,
	cred Credential,
	clientID string,
	payloadJSON []byte,
	factory MqttClientFactory,
	timeoutMs int,
) mqttDispatchResult {
	if factory == nil {
		factory = DefaultMqttClientFactory
	}
	if timeoutMs <= 0 {
		timeoutMs = DefaultBambuTimeoutMs
	}

	// Honour context cancellation before touching the network.
	if err := ctx.Err(); err != nil {
		return mqttDispatchResult{Reason: "timeout", Detail: err.Error()}
	}

	brokerURL := fmt.Sprintf("mqtts://%s:%d", cfg.IP, cfg.MqttPort)
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

	connectToken := client.Connect()
	timeout := time.Duration(timeoutMs) * time.Millisecond
	if !connectToken.WaitTimeout(timeout) {
		client.Disconnect(250)
		return mqttDispatchResult{Reason: "timeout", Detail: "MQTT connect timed out"}
	}
	if err := connectToken.Error(); err != nil {
		client.Disconnect(250)
		return mqttDispatchResult{Reason: classifyMqttErr(err.Error()), Detail: err.Error()}
	}
	defer client.Disconnect(250)

	topic := fmt.Sprintf("device/%s/request", cred.Serial)
	pubToken := client.Publish(topic, 1, false, payloadJSON)

	if !pubToken.WaitTimeout(timeout) {
		return mqttDispatchResult{Reason: "timeout", Detail: "MQTT publish timed out"}
	}
	if err := pubToken.Error(); err != nil {
		return mqttDispatchResult{Reason: classifyMqttErr(err.Error()), Detail: err.Error()}
	}

	return mqttDispatchResult{OK: true}
}

// classifyMqttErr maps a raw MQTT error message to a dispatch failure reason.
func classifyMqttErr(msg string) string {
	if mqttAuthRE.MatchString(msg) {
		return "auth-failed"
	}
	if timeoutRE.MatchString(msg) {
		return "timeout"
	}
	if networkCodeRE.MatchString(msg) {
		return "unreachable"
	}
	return "unknown"
}
