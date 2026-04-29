package proxy

import (
	"encoding/json"
	"strconv"
	"strings"
)

var routerStripHeaders = map[string]bool{
	"host":              true,
	"content-length":    true,
	"connection":        true,
	"transfer-encoding": true,
	"content-type":      true,
	"authorization":     true,
	"x-9router-source":  true,
	"x-request-source":  true,
}

var chatURLPatterns = []string{":generateContent", ":streamGenerateContent"}

var accountBootstrapPatterns = []string{
	":fetchAdminControls",
	"/cascadeNuxes",
	":loadCodeAssist",
	":fetchUserInfo",
	":fetchAvailableModels",
	"/agentPlugins",
}

func IsChatRequestURL(reqURL string) bool {
	return containsAny(reqURL, chatURLPatterns)
}

func IsFetchAvailableModelsRequest(reqURL string) bool {
	return strings.Contains(reqURL, ":fetchAvailableModels")
}

func IsFetchUserInfoRequest(reqURL string) bool {
	return strings.Contains(reqURL, ":fetchUserInfo")
}

func IsLoadCodeAssistRequest(reqURL string) bool {
	return strings.Contains(reqURL, ":loadCodeAssist")
}

func IsModelBootstrapMergeRequest(reqURL string) bool {
	return IsFetchAvailableModelsRequest(reqURL) || IsFetchUserInfoRequest(reqURL) || IsLoadCodeAssistRequest(reqURL)
}

func IsAccountBootstrapRequest(reqURL string) bool {
	return containsAny(reqURL, accountBootstrapPatterns)
}

func BuildRouterHeaders(clientHeaders map[string][]string, apiKey string) map[string]string {
	headers := map[string]string{"Content-Type": "application/json"}
	for key, values := range clientHeaders {
		if routerStripHeaders[strings.ToLower(key)] {
			continue
		}
		if len(values) == 0 {
			continue
		}
		headers[key] = strings.Join(values, ", ")
	}
	if apiKey != "" {
		headers["Authorization"] = "Bearer " + apiKey
	}
	return headers
}

func BypassInterceptReason(headers map[string][]string) string {
	value := strings.ToLower(firstHeader(headers, "x-9router-source"))
	if value == "9router" {
		return "x-9router-source=9router"
	}
	return ""
}

func ShouldBypassIntercept(headers map[string][]string) bool {
	return BypassInterceptReason(headers) != ""
}

func PassthroughLogLabel(reqURL string) string {
	if IsFetchAvailableModelsRequest(reqURL) {
		return "AUTH MODELS"
	}
	if IsAccountBootstrapRequest(reqURL) {
		return "AUTH PASS"
	}
	if IsChatRequestURL(reqURL) {
		return "CHAT PASS"
	}
	return "PASS"
}

func IsRetryableUpstreamStatus(statusCode int) bool {
	switch statusCode {
	case 408, 429, 502, 503, 504, 524:
		return true
	default:
		return false
	}
}

type RouterError struct {
	Error map[string]any `json:"error"`
}

func RouterErrorBody(statusCode int, bodyText string) map[string]any {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(bodyText), &parsed); err == nil && parsed != nil {
		return parsed
	}
	fallback := bodyText
	if fallback == "" {
		fallback = "Upstream " + strconv.Itoa(statusCode)
	}
	return map[string]any{
		"error": map[string]any{
			"message": fallback,
			"type":    "upstream_error",
			"status":  float64(statusCode),
		},
	}
}

func containsAny(value string, patterns []string) bool {
	for _, pattern := range patterns {
		if strings.Contains(value, pattern) {
			return true
		}
	}
	return false
}

func firstHeader(headers map[string][]string, key string) string {
	for headerKey, values := range headers {
		if strings.EqualFold(headerKey, key) && len(values) > 0 {
			return strings.Join(values, ", ")
		}
	}
	return ""
}
