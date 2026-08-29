package deliveryevidence

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

type (
	matrixV2     = AcceptanceMatrixV2
	rowV2        = AcceptanceMatrixV2Row
	evidenceV2   = AcceptanceEvidenceV2
	artifactV2   = AcceptanceArtifactV2
	factsRowV1   = NormalizedFactsV1Row
	factsV1      = NormalizedFactsV1
	resultV1     = AcceptanceResultV1
	resultRowV1  = AcceptanceResultV1Row
	diagnosticV1 = AcceptanceDiagnosticV1
)

type mJSON AcceptanceMatrixV2
type fJSON NormalizedFactsV1
type rJSON AcceptanceResultV1

// canonicalJSON preserves encoding/json's compact, ordered struct encoding while
// matching JSON.stringify for the two ECMAScript line-separator code points.
// The scanner operates only inside JSON string tokens, so a literal backslash-u
// sequence (encoded as \\\\u2028 or \\\\u2029) is never mistaken for a code point.
func canonicalJSON(value any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil
	}
	return canonicalECMAScriptJSON(bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}))
}

func digestBytes(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func CanonicalNormalizedFactsV1(facts NormalizedFactsV1) []byte { return canonFacts(facts) }
func NormalizedFactsSHA256V1(facts NormalizedFactsV1) string    { return normalizedFactsDigestV1(facts) }
func CanonicalAcceptanceMatrixV2(matrix AcceptanceMatrixV2) []byte {
	return canonicalAcceptanceMatrixV2Bytes(matrix)
}
func CanonicalAcceptanceResultV1(result AcceptanceResultV1) []byte { return canonResult(result) }
func (r AcceptanceResultV1) MarshalJSON() ([]byte, error) {
	return bytes.TrimSuffix(canonResult(r), []byte{'\n'}), nil
}
func (m AcceptanceMatrixV2) MarshalJSON() ([]byte, error) {
	return bytes.TrimSuffix(canonicalAcceptanceMatrixV2Bytes(m), []byte{'\n'}), nil
}

type externalInventoryReportJSON struct {
	Format  string                           `json:"format"`
	Version int                              `json:"version"`
	Entries []ExternalEvidenceInventoryEntry `json:"entries"`
}

func CanonicalExternalEvidenceInventoryReport(inventory ExternalEvidenceInventory) []byte {
	entries := make([]ExternalEvidenceInventoryEntry, 0, len(inventory.Entries))
	for _, entry := range inventory.Entries {
		if entry.Path != AcceptanceV2InventoryReportName {
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return append(canonicalJSON(externalInventoryReportJSON{Format: inventoryFmt, Version: inventoryVer, Entries: entries}), '\n')
}

func canonicalECMAScriptJSON(data []byte) []byte {
	result := make([]byte, 0, len(data))
	inString := false
	for index := 0; index < len(data); index++ {
		current := data[index]
		if !inString {
			result = append(result, current)
			if current == '"' {
				inString = true
			}
			continue
		}
		if current == '\\' {
			if index+5 < len(data) && data[index+1] == 'u' &&
				data[index+2] == '2' && data[index+3] == '0' && data[index+4] == '2' &&
				(data[index+5] == '8' || data[index+5] == '9') {
				if data[index+5] == '8' {
					result = append(result, 0xe2, 0x80, 0xa8)
				} else {
					result = append(result, 0xe2, 0x80, 0xa9)
				}
				index += 5
				continue
			}
			result = append(result, current)
			if index+1 < len(data) {
				index++
				result = append(result, data[index])
			}
			continue
		}
		result = append(result, current)
		if current == '"' {
			inString = false
		}
	}
	return result
}

type acceptanceMatrixV2Wire struct {
	mJSON
	Rows []json.RawMessage `json:"rows"`
}
type normalizedFactsV1Wire struct {
	fJSON
	Rows []json.RawMessage `json:"rows"`
}
type acceptanceResultV1Wire struct {
	rJSON
	Rows        []json.RawMessage `json:"rows"`
	Diagnostics []json.RawMessage `json:"diagnostics"`
}
type acceptanceRowJSON struct {
	ID              string          `json:"id"`
	AcceptanceClass string          `json:"acceptance_class"`
	Requirement     string          `json:"requirement"`
	Status          string          `json:"status"`
	Specification   json.RawMessage `json:"specification,omitempty"`
	Evidence        json.RawMessage `json:"evidence,omitempty"`
	Blocker         json.RawMessage `json:"blocker,omitempty"`
}
type normalizedFactsRowJSON struct {
	ID              string `json:"id"`
	AcceptanceClass string `json:"acceptanceClass"`
	Requirement     string `json:"requirement"`
}
type acceptanceResultRowJSON struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Code   string `json:"code"`
}
type acceptanceDiagnosticJSON struct {
	Code string `json:"code"`
	Path string `json:"path"`
}

func rawJSONList[T any](values []T, encode func(T) []byte) []json.RawMessage {
	result := make([]json.RawMessage, len(values))
	for index, value := range values {
		result[index] = encode(value)
	}
	return result
}
func canonEvidence(evidence evidenceV2) []byte {
	if evidence.Artifacts == nil {
		evidence.Artifacts = []artifactV2{}
	}
	return canonicalJSON(evidence)
}
func canonicalAcceptanceRowBytes(row rowV2, scope string) []byte {
	result := acceptanceRowJSON{ID: row.ID, AcceptanceClass: row.AcceptanceClass, Requirement: row.Requirement, Status: row.Status}
	raw := func(value []byte) json.RawMessage { return json.RawMessage(value) }
	if scope == "plan-publication" {
		if row.Specification == nil {
			result.Specification = raw([]byte("null"))
		} else {
			result.Specification = raw(canonEvidence(*row.Specification))
		}
	} else {
		switch {
		case row.Evidence != nil:
			result.Evidence = raw(canonEvidence(*row.Evidence))
		case row.Blocker != nil:
			result.Blocker = raw(canonicalJSON(*row.Blocker))
		case row.Status == "observed":
			result.Evidence = raw([]byte("null"))
		case row.Status == "blocked":
			result.Blocker = raw([]byte("null"))
		}
	}
	return canonicalJSON(result)
}
func canonicalAcceptanceMatrixV2Bytes(matrix matrixV2) []byte {
	rows := rawJSONList(matrix.Rows, func(row rowV2) []byte { return canonicalAcceptanceRowBytes(row, matrix.EvaluationScope) })
	return append(canonicalJSON(acceptanceMatrixV2Wire{mJSON: mJSON(matrix), Rows: rows}), '\n')
}
func isCanonicalAcceptanceMatrixV2(data []byte, matrix matrixV2) bool {
	return bytes.Equal(data, canonicalAcceptanceMatrixV2Bytes(matrix))
}
func canonFacts(facts factsV1) []byte {
	rows := rawJSONList(facts.Rows, func(row factsRowV1) []byte {
		return canonicalJSON(normalizedFactsRowJSON{ID: row.ID, AcceptanceClass: row.AcceptanceClass, Requirement: row.Requirement})
	})
	return append(canonicalJSON(normalizedFactsV1Wire{fJSON: fJSON(facts), Rows: rows}), '\n')
}
func canonResult(result resultV1) []byte {
	rows := rawJSONList(result.Rows, func(row resultRowV1) []byte {
		return canonicalJSON(acceptanceResultRowJSON{ID: row.ID, Status: row.Status, Code: row.Code})
	})
	diagnostics := rawJSONList(result.Diagnostics, func(item diagnosticV1) []byte {
		return canonicalJSON(acceptanceDiagnosticJSON{Code: item.Code, Path: item.Path})
	})
	return append(canonicalJSON(acceptanceResultV1Wire{rJSON: rJSON(result), Rows: rows, Diagnostics: diagnostics}), '\n')
}
func normalizedFactsDigestV1(facts NormalizedFactsV1) string {
	return digestBytes(append([]byte("pi-sampler.delivery-normalized-facts/v1\x00"), canonFacts(facts)...))
}
