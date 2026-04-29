package proxy

import (
	"reflect"
	"testing"
)

func TestRequestClassificationMatchesNodeHelpers(t *testing.T) {
	if !IsFetchAvailableModelsRequest("/v1internal:fetchAvailableModels") {
		t.Fatal("fetchAvailableModels should be detected")
	}
	if !IsLoadCodeAssistRequest("/v1internal:loadCodeAssist") {
		t.Fatal("loadCodeAssist should be detected")
	}
	if !IsChatRequestURL("/v1internal:streamGenerateContent") {
		t.Fatal("streamGenerateContent should be detected as chat")
	}
	if !IsAccountBootstrapRequest("/v1internal:fetchUserInfo") {
		t.Fatal("fetchUserInfo should be account bootstrap")
	}
	if IsChatRequestURL("/v1internal:fetchUserInfo") {
		t.Fatal("fetchUserInfo should not be chat")
	}
	if IsAccountBootstrapRequest("/v1internal:streamGenerateContent") {
		t.Fatal("streamGenerateContent should not be account bootstrap")
	}
	if !IsModelBootstrapMergeRequest("/v1internal:fetchUserInfo") {
		t.Fatal("fetchUserInfo should be model bootstrap merge request")
	}
}

func TestPassthroughLogLabel(t *testing.T) {
	cases := map[string]string{
		"/v1internal:fetchAvailableModels":  "AUTH MODELS",
		"/v1internal:fetchUserInfo":         "AUTH PASS",
		"/v1internal:streamGenerateContent": "CHAT PASS",
		"/health":                           "PASS",
	}
	for reqURL, expected := range cases {
		if actual := PassthroughLogLabel(reqURL); actual != expected {
			t.Fatalf("label for %s: got %q want %q", reqURL, actual, expected)
		}
	}
}

func TestBuildRouterHeadersFiltersHopAndAuthHeaders(t *testing.T) {
	headers := BuildRouterHeaders(map[string][]string{
		"Host":             {"cloudcode-pa.googleapis.com"},
		"Content-Length":   {"123"},
		"Content-Type":     {"text/plain"},
		"Authorization":    {"Bearer old"},
		"X-9Router-Source": {"9router"},
		"X-Custom":         {"a", "b"},
	}, "sk-new")

	expected := map[string]string{
		"Content-Type":  "application/json",
		"Authorization": "Bearer sk-new",
		"X-Custom":      "a, b",
	}
	if !reflect.DeepEqual(headers, expected) {
		t.Fatalf("unexpected headers:\n got %#v\nwant %#v", headers, expected)
	}
}

func TestBypassInterceptReason(t *testing.T) {
	headers := map[string][]string{"X-9Router-Source": {"9router"}}
	if !ShouldBypassIntercept(headers) {
		t.Fatal("expected bypass intercept")
	}
	if reason := BypassInterceptReason(headers); reason != "x-9router-source=9router" {
		t.Fatalf("unexpected bypass reason: %q", reason)
	}
}

func TestRetryableUpstreamStatusAndRouterErrorBody(t *testing.T) {
	if !IsRetryableUpstreamStatus(429) || !IsRetryableUpstreamStatus(524) {
		t.Fatal("expected retryable statuses")
	}
	if IsRetryableUpstreamStatus(404) {
		t.Fatal("404 should not be retryable")
	}

	preserved := RouterErrorBody(404, `{"error":{"message":"No active credentials for provider: antigravity"}}`)
	message := preserved["error"].(map[string]any)["message"]
	if message != "No active credentials for provider: antigravity" {
		t.Fatalf("expected preserved JSON error, got %#v", preserved)
	}

	wrapped := RouterErrorBody(524, "<html>timeout</html>")
	errorBody := wrapped["error"].(map[string]any)
	if errorBody["type"] != "upstream_error" || errorBody["status"] != float64(524) {
		t.Fatalf("unexpected wrapped error: %#v", wrapped)
	}
}
