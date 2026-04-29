package constants

const (
	AppName            = "mitm-antigravity"
	DefaultTarget      = "daily-cloudcode-pa.googleapis.com"
	DefaultRemote      = "127.0.0.1"
	DefaultRouterURL   = "http://localhost:20128/v1/chat/completions"
	DefaultModelPrefix = "ag/"
)

var DefaultTargetHosts = []string{
	"daily-cloudcode-pa.googleapis.com",
	"cloudcode-pa.googleapis.com",
}

var AntigravityAliases = []string{
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.5-flash-thinking",
	"gemini-2.5-flash-lite",
	"gemini-3.1-pro-high",
	"gemini-3.1-pro-low",
	"gemini-3.1-flash-lite",
	"gemini-3.1-flash-image",
	"gemini-3-flash",
	"gemini-3-flash-agent",
	"gemini-3-flash-a",
	"gemini-3-flash-b",
	"gemini-3-flash-c",
	"claude-sonnet-4-6",
	"claude-opus-4-6-thinking",
	"gpt-oss-120b-medium",
	"gemini-3-pro-high",
	"gemini-3-pro-low",
	"tab_flash_lite_preview",
	"tab_jump_flash_lite_preview",
}

var MappableAntigravityAliases = []string{
	"gemini-3.1-pro-high",
	"gemini-3.1-pro-low",
	"gemini-3-flash",
	"claude-sonnet-4-6",
	"claude-opus-4-6-thinking",
	"gpt-oss-120b-medium",
}

func LegacyDefaultModelMap() map[string]any {
	result := make(map[string]any, len(AntigravityAliases))
	for _, alias := range AntigravityAliases {
		result[alias] = "cx/gpt-5.5"
	}
	return result
}
