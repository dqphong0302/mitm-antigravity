package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"mitm-antigravity/backend-go/internal/models"
)

func TestReadConfigUsesSettingsJsonAndNormalizesModelMap(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("MITM_APP_DIR", tmp)
	t.Setenv("MITM_RUNTIME_DIR", tmp)

	hostname := MachineID()
	settings := map[string]any{
		"activeMachine": hostname,
		"machines": map[string]any{
			hostname: map[string]any{
				"routerUrl": "https://router.local/v1/chat/completions",
				"apiKey":    "sk-test",
				"port":      9443,
				"modelMap": map[string]any{
					"gemini-3.1-pro-high": map[string]any{"model": "cx/gpt-5.5", "thinking": "high"},
					"custom-model":        "cx/custom",
				},
			},
		},
	}
	writeJSON(t, filepath.Join(tmp, "settings.json"), settings)

	cfg, err := ReadConfig()
	if err != nil {
		t.Fatalf("ReadConfig failed: %v", err)
	}

	if cfg.RouterURL != "https://router.local/v1/chat/completions" {
		t.Fatalf("unexpected router URL: %q", cfg.RouterURL)
	}
	if cfg.APIKey != "sk-test" {
		t.Fatalf("unexpected api key: %q", cfg.APIKey)
	}
	if cfg.Port != 9443 {
		t.Fatalf("unexpected port: %d", cfg.Port)
	}
	if _, ok := cfg.ModelMap["custom-model"]; ok {
		t.Fatalf("custom model should be dropped from mappable modelMap: %#v", cfg.ModelMap)
	}
	entry, ok := cfg.ModelMap["gemini-3.1-pro-high"].(models.MappingEntry)
	if !ok || entry.Model != "cx/gpt-5.5" || entry.ReasoningEffort != "high" {
		t.Fatalf("unexpected normalized mapping: %#v", cfg.ModelMap["gemini-3.1-pro-high"])
	}
}

func TestTargetHostsFromExpandsDefaultHost(t *testing.T) {
	cfg := DefaultConfig()
	cfg.TargetHosts = []string{"daily-cloudcode-pa.googleapis.com"}

	hosts := TargetHostsFrom(cfg)
	if len(hosts) != 2 {
		t.Fatalf("expected default host expansion, got %#v", hosts)
	}
	if PrimaryTargetHost(cfg) != "daily-cloudcode-pa.googleapis.com" {
		t.Fatalf("unexpected primary target: %q", PrimaryTargetHost(cfg))
	}
}

func writeJSON(t *testing.T, filePath string, value any) {
	t.Helper()
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	if err := os.WriteFile(filePath, append(content, '\n'), 0o600); err != nil {
		t.Fatalf("write json: %v", err)
	}
}
