package models

import (
	"encoding/json"
	"strings"

	"mitm-antigravity/backend-go/internal/constants"
)

type MappingEntry struct {
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

var mappableAliasSet = makeStringSet(constants.MappableAntigravityAliases)
var antigravityAliasSet = makeStringSet(constants.AntigravityAliases)

func makeStringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func NormalizeMappingEntry(value any) (MappingEntry, bool) {
	switch entry := value.(type) {
	case string:
		model := strings.TrimSpace(entry)
		if model == "" {
			return MappingEntry{}, false
		}
		return MappingEntry{Model: model}, true
	case map[string]any:
		return normalizeMappingObject(entry)
	case map[string]string:
		object := make(map[string]any, len(entry))
		for key, val := range entry {
			object[key] = val
		}
		return normalizeMappingObject(object)
	case MappingEntry:
		model := strings.TrimSpace(entry.Model)
		reasoning := strings.TrimSpace(entry.ReasoningEffort)
		if model == "" {
			return MappingEntry{}, false
		}
		return MappingEntry{Model: model, ReasoningEffort: reasoning}, true
	default:
		return MappingEntry{}, false
	}
}

func normalizeMappingObject(entry map[string]any) (MappingEntry, bool) {
	model := stringField(entry, "model")
	reasoning := firstStringField(entry, "reasoning_effort", "thinking", "reasoning")
	if model == "" {
		return MappingEntry{}, false
	}
	return MappingEntry{Model: model, ReasoningEffort: reasoning}, true
}

func stringField(entry map[string]any, key string) string {
	value, ok := entry[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(toString(value))
}

func firstStringField(entry map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringField(entry, key); value != "" {
			return value
		}
	}
	return ""
}

func toString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	default:
		return strings.TrimSpace(strings.Trim(string(mustJSON(value)), "\""))
	}
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

func NormalizeModelMap(modelMap map[string]any) map[string]any {
	if modelMap == nil {
		return map[string]any{}
	}

	normalized := make(map[string]MappingEntry)
	for rawKey, rawValue := range modelMap {
		key := strings.TrimSpace(rawKey)
		entry, ok := NormalizeMappingEntry(rawValue)
		if key == "" || !ok {
			continue
		}
		normalized[key] = entry
	}

	stripped := stripLegacyDefaultMappings(normalized)
	result := make(map[string]any)
	for key, entry := range stripped {
		if !mappableAliasSet[key] || isGeneratedBuiltInPrefixMapping(key, entry) {
			continue
		}
		if entry.ReasoningEffort != "" {
			result[key] = entry
		} else {
			result[key] = entry.Model
		}
	}
	return result
}

func stripLegacyDefaultMappings(modelMap map[string]MappingEntry) map[string]MappingEntry {
	if len(modelMap) != len(constants.AntigravityAliases) {
		return modelMap
	}
	for _, alias := range constants.AntigravityAliases {
		entry, ok := modelMap[alias]
		if !ok || entry.Model != "cx/gpt-5.5" {
			return modelMap
		}
	}
	return map[string]MappingEntry{}
}

func isGeneratedBuiltInPrefixMapping(alias string, entry MappingEntry) bool {
	return entry.ReasoningEffort == "" && antigravityAliasSet[alias] && entry.Model == constants.DefaultModelPrefix+alias
}

func GetMappedEntry(model string, modelMap map[string]any) (MappingEntry, bool) {
	normalized := NormalizeModelMap(modelMap)
	entry, ok := normalized[model]
	if !ok {
		return MappingEntry{}, false
	}
	return NormalizeMappingEntry(entry)
}
