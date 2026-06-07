package bambu

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"
)

// ---------------------------------------------------------------------------
// Fake FTPS client
// ---------------------------------------------------------------------------

type fakeFtpConn struct {
	loginErr error
	storErr  error
	// captures
	loginUser string
	loginPass string
	storPath  string
}

func (f *fakeFtpConn) Login(user, password string) error {
	f.loginUser = user
	f.loginPass = password
	return f.loginErr
}

func (f *fakeFtpConn) Stor(path string, _ io.Reader) error {
	f.storPath = path
	return f.storErr
}

func (f *fakeFtpConn) Quit() error { return nil }

// newFakeFtpDialer returns a FtpDialer that always returns the given fakeFtpConn.
func newFakeFtpDialer(conn *fakeFtpConn, dialErr error) FtpDialer {
	return func(_ string, _ *tls.Config) (FtpConn, error) {
		if dialErr != nil {
			return nil, dialErr
		}
		return conn, nil
	}
}

// ---------------------------------------------------------------------------
// Fake MQTT token + client
// ---------------------------------------------------------------------------

// fakeToken satisfies paho.Token.  WaitTimeout always returns true (simulates
// immediate completion).  Error returns the injected err.
type fakeToken struct{ err error }

func (t *fakeToken) Wait() bool                      { return true }
func (t *fakeToken) WaitTimeout(_ time.Duration) bool { return true }
func (t *fakeToken) Done() <-chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}
func (t *fakeToken) Error() error { return t.err }

// compile-time interface check
var _ paho.Token = (*fakeToken)(nil)

// fakeMqttClient implements MqttClient.
type fakeMqttClient struct {
	connectErr error
	publishErr error
	// captures
	publishedTopic   string
	publishedPayload []byte
}

func (m *fakeMqttClient) Connect() paho.Token {
	return &fakeToken{err: m.connectErr}
}

func (m *fakeMqttClient) Publish(topic string, _ byte, _ bool, payload any) paho.Token {
	m.publishedTopic = topic
	if b, ok := payload.([]byte); ok {
		m.publishedPayload = b
	}
	return &fakeToken{err: m.publishErr}
}

func (m *fakeMqttClient) Disconnect(_ uint) {}

func newFakeMqttFactory(mc *fakeMqttClient) MqttClientFactory {
	return func(_ string, _ mqttOpts) MqttClient {
		return mc
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func bg() context.Context { return context.Background() }

// sampleConnCfg returns a minimal valid connection-config JSON.
func sampleConnCfgJSON() json.RawMessage {
	return json.RawMessage(`{"ip":"192.168.1.10"}`)
}

// sampleCredJSON returns a minimal valid credential JSON.
func sampleCredJSON() json.RawMessage {
	return json.RawMessage(`{"accessCode":"ABCD1234","serial":"01P00A123456789"}`)
}

// makeTempThreeMF creates a minimal .gcode.3mf file (single-colour) in a temp
// dir and returns its path.
func makeTempThreeMF(t *testing.T) string {
	t.Helper()
	// Build a ZIP with a slice_info.config that has ONE filament → no AMS.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("Metadata/slice_info.config")
	if err != nil {
		t.Fatalf("zip Create: %v", err)
	}
	_, _ = w.Write([]byte(`<config><plate><filament id="0" type="PLA"/></plate></config>`))
	_ = zw.Close()

	p := filepath.Join(t.TempDir(), "model.gcode.3mf")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write temp 3mf: %v", err)
	}
	return p
}

// ---------------------------------------------------------------------------
// Tests — Dispatch orchestration (faked network layer)
// ---------------------------------------------------------------------------

func TestDispatch_BadConfig(t *testing.T) {
	out := Dispatch(bg(), []byte(`{}`), sampleCredJSON(), "/tmp/x.gcode.3mf", nil, DispatchDeps{})
	if out.OK {
		t.Fatal("expected failure for missing ip")
	}
	if out.Reason != "unknown" {
		t.Errorf("want reason=unknown, got %s", out.Reason)
	}
}

func TestDispatch_BadCredential(t *testing.T) {
	out := Dispatch(bg(), sampleConnCfgJSON(), []byte(`{}`), "/tmp/x.gcode.3mf", nil, DispatchDeps{})
	if out.OK {
		t.Fatal("expected failure for missing credential")
	}
	if out.Reason != "auth-failed" {
		t.Errorf("want reason=auth-failed, got %s", out.Reason)
	}
}

func TestDispatch_NonThreeMF(t *testing.T) {
	p := filepath.Join(t.TempDir(), "model.gcode")
	_ = os.WriteFile(p, []byte("G0 X0\n"), 0o644)

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), p, nil, DispatchDeps{})
	if out.OK {
		t.Fatal("expected failure for non-.3mf file")
	}
	if out.Reason != "rejected" {
		t.Errorf("want reason=rejected, got %s", out.Reason)
	}
}

func TestDispatch_FtpDialFails_Unreachable(t *testing.T) {
	path := makeTempThreeMF(t)
	fakeFtp := newFakeFtpDialer(nil, errors.New("ECONNREFUSED dial failed"))

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer: fakeFtp,
	})
	if out.OK {
		t.Fatal("expected failure")
	}
	if out.Reason != "unreachable" {
		t.Errorf("want reason=unreachable, got %s", out.Reason)
	}
}

func TestDispatch_FtpLoginFails_AuthFailed(t *testing.T) {
	path := makeTempThreeMF(t)
	ftpConn := &fakeFtpConn{loginErr: errors.New("530 login incorrect")}
	fakeFtp := newFakeFtpDialer(ftpConn, nil)

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer: fakeFtp,
	})
	if out.OK {
		t.Fatal("expected failure")
	}
	if out.Reason != "auth-failed" {
		t.Errorf("want reason=auth-failed, got %s", out.Reason)
	}
}

func TestDispatch_FtpStorFails(t *testing.T) {
	path := makeTempThreeMF(t)
	ftpConn := &fakeFtpConn{storErr: errors.New("connection reset")}
	fakeFtp := newFakeFtpDialer(ftpConn, nil)

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer: fakeFtp,
	})
	if out.OK {
		t.Fatal("expected failure")
	}
	// "connection reset" doesn't match any specific code — falls through to unknown
	// (ECONNRESET would match networkCodeRE; "connection reset" alone does not).
	if out.Reason == "" {
		t.Error("expected non-empty reason")
	}
}

func TestDispatch_UploadOnly_Success(t *testing.T) {
	path := makeTempThreeMF(t)
	ftpConn := &fakeFtpConn{}
	fakeFtp := newFakeFtpDialer(ftpConn, nil)

	// startPrint=false in the connection config.
	cfgJSON := json.RawMessage(`{"ip":"192.168.1.10","startPrint":false}`)

	out := Dispatch(bg(), cfgJSON, sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer: fakeFtp,
	})
	if !out.OK {
		t.Fatalf("expected success, got reason=%s details=%s", out.Reason, out.Details)
	}
	if out.RemoteFilename != "/cache/model.gcode.3mf" {
		t.Errorf("remoteFilename: want /cache/model.gcode.3mf, got %q", out.RemoteFilename)
	}
	// No MQTT interaction when startPrint=false.
}

func TestDispatch_MqttConnectFails_Unreachable(t *testing.T) {
	path := makeTempThreeMF(t)
	ftpConn := &fakeFtpConn{}
	fakeFtp := newFakeFtpDialer(ftpConn, nil)

	mqttClient := &fakeMqttClient{connectErr: errors.New("ECONNREFUSED: no route to host")}
	fakeMqtt := newFakeMqttFactory(mqttClient)

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer:   fakeFtp,
		MqttFactory: fakeMqtt,
	})
	if out.OK {
		t.Fatal("expected failure")
	}
	if out.Reason != "unreachable" {
		t.Errorf("want reason=unreachable, got %s", out.Reason)
	}
}

func TestDispatch_MqttAuthFails(t *testing.T) {
	path := makeTempThreeMF(t)
	ftpConn := &fakeFtpConn{}
	fakeFtp := newFakeFtpDialer(ftpConn, nil)

	mqttClient := &fakeMqttClient{connectErr: errors.New("not authorized")}
	fakeMqtt := newFakeMqttFactory(mqttClient)

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer:   fakeFtp,
		MqttFactory: fakeMqtt,
	})
	if out.OK {
		t.Fatal("expected failure")
	}
	if out.Reason != "auth-failed" {
		t.Errorf("want reason=auth-failed, got %s", out.Reason)
	}
}

func TestDispatch_MqttPublishFails(t *testing.T) {
	path := makeTempThreeMF(t)
	ftpConn := &fakeFtpConn{}
	fakeFtp := newFakeFtpDialer(ftpConn, nil)

	mqttClient := &fakeMqttClient{publishErr: errors.New("publish timeout")}
	fakeMqtt := newFakeMqttFactory(mqttClient)

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer:   fakeFtp,
		MqttFactory: fakeMqtt,
	})
	if out.OK {
		t.Fatal("expected failure on publish error")
	}
	if out.Reason != "timeout" {
		t.Errorf("want reason=timeout, got %s", out.Reason)
	}
}

func TestDispatch_Success_SingleColor(t *testing.T) {
	path := makeTempThreeMF(t)
	ftpConn := &fakeFtpConn{}
	fakeFtp := newFakeFtpDialer(ftpConn, nil)

	mqttClient := &fakeMqttClient{}
	fakeMqtt := newFakeMqttFactory(mqttClient)

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer:   fakeFtp,
		MqttFactory: fakeMqtt,
	})
	if !out.OK {
		t.Fatalf("expected success, got reason=%s details=%s", out.Reason, out.Details)
	}
	if out.RemoteFilename != "/cache/model.gcode.3mf" {
		t.Errorf("remoteFilename: want /cache/model.gcode.3mf, got %q", out.RemoteFilename)
	}

	// Verify MQTT topic.
	if mqttClient.publishedTopic != "device/01P00A123456789/request" {
		t.Errorf("mqtt topic: want device/01P00A123456789/request, got %q", mqttClient.publishedTopic)
	}

	// Verify MQTT payload shape.
	var cmd PrintCommand
	if err := json.Unmarshal(mqttClient.publishedPayload, &cmd); err != nil {
		t.Fatalf("unmarshal mqtt payload: %v", err)
	}
	if cmd.Print.Command != "project_file" {
		t.Errorf("command: want project_file, got %s", cmd.Print.Command)
	}
	if cmd.Print.UseAms {
		t.Error("single-colour print should have use_ams=false")
	}
	if len(cmd.Print.AmsMapping) != 0 {
		t.Errorf("single-colour print should have empty ams_mapping, got %v", cmd.Print.AmsMapping)
	}
	if cmd.Print.URL != "ftp:///cache/model.gcode.3mf" {
		t.Errorf("url: want ftp:///cache/model.gcode.3mf, got %s", cmd.Print.URL)
	}
	if cmd.Print.Param != "Metadata/plate_1.gcode" {
		t.Errorf("param: want Metadata/plate_1.gcode, got %s", cmd.Print.Param)
	}
	// BedLevelling / FlowCali / VibrationCali are true by default.
	if !cmd.Print.BedLevelling {
		t.Error("bed_levelling should be true by default")
	}
	if !cmd.Print.FlowCali {
		t.Error("flow_cali should be true by default")
	}
	if !cmd.Print.VibrationCali {
		t.Error("vibration_cali should be true by default")
	}

	// Verify FTP upload path.
	if ftpConn.storPath != "/cache/model.gcode.3mf" {
		t.Errorf("ftp storPath: want /cache/model.gcode.3mf, got %q", ftpConn.storPath)
	}
	if ftpConn.loginUser != BambuLanUsername {
		t.Errorf("ftp username: want %s, got %s", BambuLanUsername, ftpConn.loginUser)
	}
}

func TestDispatch_Success_MultiColor(t *testing.T) {
	// Build a 4-colour 3MF.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("Metadata/slice_info.config")
	_, _ = w.Write([]byte(multiColorXML))
	_ = zw.Close()

	path := filepath.Join(t.TempDir(), "4color.gcode.3mf")
	_ = os.WriteFile(path, buf.Bytes(), 0o644)

	ftpConn := &fakeFtpConn{}
	mqttClient := &fakeMqttClient{}

	out := Dispatch(bg(), sampleConnCfgJSON(), sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer:   newFakeFtpDialer(ftpConn, nil),
		MqttFactory: newFakeMqttFactory(mqttClient),
	})
	if !out.OK {
		t.Fatalf("expected success, got reason=%s details=%s", out.Reason, out.Details)
	}

	var cmd PrintCommand
	if err := json.Unmarshal(mqttClient.publishedPayload, &cmd); err != nil {
		t.Fatalf("unmarshal mqtt payload: %v", err)
	}
	if !cmd.Print.UseAms {
		t.Error("4-colour print should have use_ams=true")
	}
	if len(cmd.Print.AmsMapping) != 4 {
		t.Errorf("want 4 ams_mapping entries, got %d: %v", len(cmd.Print.AmsMapping), cmd.Print.AmsMapping)
	}
}

func TestDispatch_ForceAmsDisabled(t *testing.T) {
	// Build a 4-colour 3MF but forceAmsDisabled=true.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("Metadata/slice_info.config")
	_, _ = w.Write([]byte(multiColorXML))
	_ = zw.Close()

	path := filepath.Join(t.TempDir(), "4color_noams.gcode.3mf")
	_ = os.WriteFile(path, buf.Bytes(), 0o644)

	cfgJSON := json.RawMessage(`{"ip":"192.168.1.10","forceAmsDisabled":true}`)
	ftpConn := &fakeFtpConn{}
	mqttClient := &fakeMqttClient{}

	out := Dispatch(bg(), cfgJSON, sampleCredJSON(), path, nil, DispatchDeps{
		FtpDialer:   newFakeFtpDialer(ftpConn, nil),
		MqttFactory: newFakeMqttFactory(mqttClient),
	})
	if !out.OK {
		t.Fatalf("expected success, got reason=%s details=%s", out.Reason, out.Details)
	}

	var cmd PrintCommand
	if err := json.Unmarshal(mqttClient.publishedPayload, &cmd); err != nil {
		t.Fatalf("unmarshal mqtt payload: %v", err)
	}
	if cmd.Print.UseAms {
		t.Error("forceAmsDisabled should override slicer hint — use_ams should be false")
	}
	if len(cmd.Print.AmsMapping) != 0 {
		t.Errorf("forceAmsDisabled should produce empty ams_mapping, got %v", cmd.Print.AmsMapping)
	}
}

// ---------------------------------------------------------------------------
// Tests — BuildPrintCommand shape
// ---------------------------------------------------------------------------

func TestBuildPrintCommand_Shape(t *testing.T) {
	cfg := ConnectionConfig{
		IP:            "1.2.3.4",
		MqttPort:      8883,
		FtpPort:       990,
		PlateIndex:    2,
		BedLevelling:  false,
		FlowCalibration: true,
		VibrationCal:  false,
		LayerInspect:  true,
		Timelapse:     true,
		BedType:       "textured_pei_plate",
	}
	ams := AmsConfig{SubtaskName: "mymodel", PlateIndex: 1}

	cmd := BuildPrintCommand(cfg, "mymodel.gcode.3mf", ams, true, []int{0, 1})

	if cmd.Print.Param != "Metadata/plate_2.gcode" {
		t.Errorf("param: want Metadata/plate_2.gcode, got %s", cmd.Print.Param)
	}
	if cmd.Print.URL != "ftp:///cache/mymodel.gcode.3mf" {
		t.Errorf("url: want ftp:///cache/mymodel.gcode.3mf, got %s", cmd.Print.URL)
	}
	if cmd.Print.SubtaskName != "mymodel" {
		t.Errorf("subtask_name: want mymodel, got %s", cmd.Print.SubtaskName)
	}
	if cmd.Print.BedType != "textured_pei_plate" {
		t.Errorf("bed_type: want textured_pei_plate, got %s", cmd.Print.BedType)
	}
	if cmd.Print.BedLevelling {
		t.Error("bed_levelling should be false")
	}
	if !cmd.Print.FlowCali {
		t.Error("flow_cali should be true")
	}
	if cmd.Print.VibrationCali {
		t.Error("vibration_cali should be false")
	}
	if !cmd.Print.LayerInspect {
		t.Error("layer_inspect should be true")
	}
	if !cmd.Print.Timelapse {
		t.Error("timelapse should be true")
	}
	if !cmd.Print.UseAms {
		t.Error("use_ams should be true")
	}
	if len(cmd.Print.AmsMapping) != 2 {
		t.Errorf("ams_mapping: want 2, got %v", cmd.Print.AmsMapping)
	}
	// Fixed protocol fields.
	if cmd.Print.Command != "project_file" {
		t.Errorf("command: want project_file, got %s", cmd.Print.Command)
	}
	if cmd.Print.SequenceID != "0" {
		t.Errorf("sequence_id: want \"0\", got %s", cmd.Print.SequenceID)
	}
	if cmd.Print.ProjectID != "0" || cmd.Print.ProfileID != "0" ||
		cmd.Print.TaskID != "0" || cmd.Print.SubtaskID != "0" {
		t.Error("fixed ID fields should all be \"0\"")
	}
}
