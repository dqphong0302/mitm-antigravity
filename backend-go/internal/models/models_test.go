package models

import (
	"reflect"
	"testing"
)

func TestNormalizeModelMapKeepsOnlyMappableAliases(t *testing.T) {
	result := NormalizeModelMap(map[string]any{
		"claude-opus-4-6-thinking": "ag/claude-opus-4-6-thinking",
		"gemini-3-flash": map[string]any{
			"model":            "cx/gemini-3-flash",
			"reasoning_effort": "low",
		},
		"gpt-oss-120b-medium": "cx/gpt-oss",
		"gemini-2.5-pro":      "cx/not-mappable",
		"custom-router-model": "cx/custom-router-model",
	})

	if _, ok := result["claude-opus-4-6-thinking"]; ok {
		t.Fatalf("generated built-in prefix mapping should be stripped: %#v", result)
	}
	if _, ok := result["gemini-2.5-pro"]; ok {
		t.Fatalf("non-mappable alias should be stripped: %#v", result)
	}
	if _, ok := result["custom-router-model"]; ok {
		t.Fatalf("custom alias should be stripped: %#v", result)
	}

	expected := MappingEntry{Model: "cx/gemini-3-flash", ReasoningEffort: "low"}
	actual, ok := result["gemini-3-flash"].(MappingEntry)
	if !ok || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("unexpected gemini-3-flash mapping: %#v", result["gemini-3-flash"])
	}
	if result["gpt-oss-120b-medium"] != "cx/gpt-oss" {
		t.Fatalf("string mapping was not preserved: %#v", result["gpt-oss-120b-medium"])
	}
}

func TestThinkingAndReasoningAliasesNormalizeToReasoningEffort(t *testing.T) {
	result := NormalizeModelMap(map[string]any{
		"gemini-3.1-pro-high": map[string]any{"model": "cx/gpt-5.5", "thinking": "high"},
		"gemini-3.1-pro-low":  map[string]any{"model": "cx/gpt-5.5", "reasoning": "low"},
	})

	high, ok := result["gemini-3.1-pro-high"].(MappingEntry)
	if !ok || !reflect.DeepEqual(high, MappingEntry{Model: "cx/gpt-5.5", ReasoningEffort: "high"}) {
		t.Fatalf("thinking alias was not normalized: %#v", result["gemini-3.1-pro-high"])
	}

	low, ok := result["gemini-3.1-pro-low"].(MappingEntry)
	if !ok || !reflect.DeepEqual(low, MappingEntry{Model: "cx/gpt-5.5", ReasoningEffort: "low"}) {
		t.Fatalf("reasoning alias was not normalized: %#v", result["gemini-3.1-pro-low"])
	}
}
