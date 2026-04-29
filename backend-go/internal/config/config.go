package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"mitm-antigravity/backend-go/internal/constants"
	"mitm-antigravity/backend-go/internal/models"
)

type Config struct {
	TargetHost      string         `json:"targetHost"`
	TargetHosts     []string       `json:"targetHosts"`
	RemoteIP        string         `json:"remoteIp"`
	RemoteHost      string         `json:"remoteHost"`
	Port            int            `json:"port"`
	RouterURL       string         `json:"routerUrl"`
	APIKey          string         `json:"apiKey"`
	Model           string         `json:"model"`
	ModelPrefix     string         `json:"modelPrefix"`
	AlwaysIntercept bool           `json:"alwaysIntercept"`
	MockModelList   bool           `json:"mockModelList"`
	ModelMap        map[string]any `json:"modelMap"`
	MaxRetries      int            `json:"maxRetries"`
	RetryDelay      int            `json:"retryDelay"`
	RetryBackoff    float64        `json:"retryBackoff"`
}

type Settings struct {
	ActiveMachine string            `json:"activeMachine"`
	Machines      map[string]Config `json:"machines"`
}

func DefaultConfig() Config {
	return Config{
		TargetHost:      constants.DefaultTarget,
		TargetHosts:     append([]string{}, constants.DefaultTargetHosts...),
		RemoteIP:        constants.DefaultRemote,
		RemoteHost:      "",
		Port:            443,
		RouterURL:       constants.DefaultRouterURL,
		APIKey:          "",
		Model:           "",
		ModelPrefix:     "",
		AlwaysIntercept: false,
		MockModelList:   false,
		ModelMap:        map[string]any{},
		MaxRetries:      5,
		RetryDelay:      1000,
		RetryBackoff:    1.5,
	}
}

func AppDir() string {
	if value := os.Getenv("MITM_APP_DIR"); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "." + constants.AppName
	}
	return filepath.Join(home, "."+constants.AppName)
}

func RuntimeDir() string {
	if value := os.Getenv("MITM_RUNTIME_DIR"); value != "" {
		return value
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}

func ConfigPath() string {
	return filepath.Join(AppDir(), "config.json")
}

func SettingsPath() string {
	return filepath.Join(AppDir(), "settings.json")
}

func BundledSettingsPath() string {
	return filepath.Join(RuntimeDir(), "settings.json")
}

func MachineID() string {
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		return "default"
	}
	return hostname
}

func ReadConfig() (Config, error) {
	legacy, err := readConfigFile(ConfigPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}
	bundledSettings, err := readSettingsFile(BundledSettingsPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}
	primarySettings, err := readSettingsFile(SettingsPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, err
	}

	cfg := MergeConfig(DefaultConfig(), currentMachineConfig(bundledSettings))
	cfg = MergeConfig(cfg, legacy)
	if primarySettings.ActiveMachine == "" && len(primarySettings.Machines) == 0 {
		return cfg, nil
	}
	return MergeConfig(cfg, currentMachineConfig(primarySettings)), nil
}

func MergeConfig(base Config, override Config) Config {
	merged := base
	if override.TargetHost != "" {
		merged.TargetHost = override.TargetHost
	}
	if len(override.TargetHosts) > 0 {
		merged.TargetHosts = normalizeTargetHosts(override.TargetHosts)
	}
	if override.RemoteIP != "" {
		merged.RemoteIP = override.RemoteIP
	}
	if override.RemoteHost != "" {
		merged.RemoteHost = override.RemoteHost
	}
	if override.Port != 0 {
		merged.Port = override.Port
	}
	if override.RouterURL != "" {
		merged.RouterURL = override.RouterURL
	}
	if override.APIKey != "" {
		merged.APIKey = override.APIKey
	}
	if override.Model != "" {
		merged.Model = override.Model
	}
	merged.ModelPrefix = override.ModelPrefix
	merged.AlwaysIntercept = override.AlwaysIntercept
	merged.MockModelList = override.MockModelList
	if override.MaxRetries != 0 {
		merged.MaxRetries = override.MaxRetries
	}
	if override.RetryDelay != 0 {
		merged.RetryDelay = override.RetryDelay
	}
	if override.RetryBackoff != 0 {
		merged.RetryBackoff = override.RetryBackoff
	}
	merged.ModelMap = models.NormalizeModelMap(mergeModelMaps(base.ModelMap, override.ModelMap))
	return merged
}

func TargetHostsFrom(cfg Config) []string {
	hosts := normalizeTargetHosts(append(cfg.TargetHosts, cfg.TargetHost))
	if len(hosts) == 0 {
		hosts = append([]string{}, constants.DefaultTargetHosts...)
	}
	if contains(hosts, constants.DefaultTarget) {
		hosts = normalizeTargetHosts(append(hosts, constants.DefaultTargetHosts...))
	}
	return hosts
}

func PrimaryTargetHost(cfg Config) string {
	hosts := TargetHostsFrom(cfg)
	if len(hosts) == 0 {
		return constants.DefaultTarget
	}
	return hosts[0]
}

func readConfigFile(filePath string) (Config, error) {
	var cfg Config
	content, err := os.ReadFile(filePath)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(content, &cfg); err != nil {
		return cfg, err
	}
	cfg.ModelMap = normalizeJSONMap(cfg.ModelMap)
	return cfg, nil
}

func readSettingsFile(filePath string) (Settings, error) {
	var settings Settings
	content, err := os.ReadFile(filePath)
	if err != nil {
		return settings, err
	}
	if err := json.Unmarshal(content, &settings); err != nil {
		return settings, err
	}
	if settings.ActiveMachine == "" {
		settings.ActiveMachine = MachineID()
	}
	if settings.Machines == nil {
		settings.Machines = map[string]Config{}
	}
	for key, cfg := range settings.Machines {
		cfg.ModelMap = normalizeJSONMap(cfg.ModelMap)
		settings.Machines[key] = cfg
	}
	return settings, nil
}

func currentMachineConfig(settings Settings) Config {
	if settings.Machines == nil {
		return Config{}
	}
	id := MachineID()
	if cfg, ok := settings.Machines[id]; ok {
		return cfg
	}
	if cfg, ok := settings.Machines[settings.ActiveMachine]; ok {
		return cfg
	}
	return Config{}
}

func normalizeJSONMap(value map[string]any) map[string]any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func mergeModelMaps(base, override map[string]any) map[string]any {
	merged := map[string]any{}
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range override {
		merged[key] = value
	}
	return merged
}

func normalizeTargetHosts(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, raw := range values {
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' || r == '\r' }) {
			host := strings.TrimSpace(part)
			if host == "" || seen[host] {
				continue
			}
			seen[host] = true
			result = append(result, host)
		}
	}
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
