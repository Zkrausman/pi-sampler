// Package wikigovernance enforces the repository boundary for shared Wiki/OKF
// collaboration material. It intentionally has no network, broker, telemetry,
// credential, or external-storage dependencies.
package wikigovernance

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const SchemaVersion = "wiki-governance-path-policy/v1"

type Classification string

const (
	Canonical        Classification = "canonical_versioned"
	GeneratedLocal   Classification = "generated_local"
	ExternalEvidence Classification = "external_immutable_evidence"
	SensitiveLocal   Classification = "sensitive_never_commit"
	OutsideScope     Classification = "outside_governance_scope"
)

type Policy struct {
	JSONSchema         string   `json:"$schema"`
	SchemaVersion      string   `json:"schema_version"`
	Canonical          []string `json:"canonical_versioned"`
	Generated          []string `json:"generated_local"`
	External           []string `json:"external_immutable_evidence"`
	Sensitive          []string `json:"sensitive_never_commit"`
	CleanCloneAbsent   []string `json:"clean_clone_must_not_contain"`
	ReferenceManifests []string `json:"reference_manifests"`
}

var secretValue = regexp.MustCompile(`(?im)(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}`)
var bearerValue = regexp.MustCompile(`(?im)authorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9_./+=-]{12,}`)
var sourceIdentifier = regexp.MustCompile(`^SRC-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{3}$`)
var sha256Digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// LoadPolicy loads the single versioned source of truth for path classification.
func LoadPolicy(repositoryRoot string) (Policy, error) {
	path := filepath.Join(repositoryRoot, "docs", "wiki-governance", "path-policy-v1.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return Policy{}, fmt.Errorf("read path policy: %w", err)
	}
	var policy Policy
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return Policy{}, fmt.Errorf("decode path policy: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return Policy{}, fmt.Errorf("path policy must contain exactly one JSON object")
	}
	if policy.SchemaVersion != SchemaVersion {
		return Policy{}, fmt.Errorf("unsupported path policy schema %q", policy.SchemaVersion)
	}
	for name, patterns := range map[string][]string{
		"canonical_versioned":         policy.Canonical,
		"generated_local":             policy.Generated,
		"external_immutable_evidence": policy.External,
		"sensitive_never_commit":      policy.Sensitive,
	} {
		if len(patterns) == 0 {
			return Policy{}, fmt.Errorf("path policy %s must not be empty", name)
		}
	}
	return policy, nil
}

// Classify returns the fail-closed class for a repository-relative path.
func (p Policy) Classify(path string) Classification {
	path = normalize(path)
	if path == "" || strings.HasPrefix(path, "../") || filepath.IsAbs(path) {
		return SensitiveLocal
	}
	for _, entry := range []struct {
		class    Classification
		patterns []string
	}{
		{Canonical, p.Canonical},
		{GeneratedLocal, p.Generated},
		{ExternalEvidence, p.External},
		{SensitiveLocal, p.Sensitive},
	} {
		if matchesAny(path, entry.patterns) {
			return entry.class
		}
	}
	if strings.HasPrefix(path, ".llm-wiki/") || strings.HasPrefix(path, ".pi/") || strings.HasPrefix(path, "evidence/raw/") || strings.HasPrefix(path, "artifacts/tool-output/") {
		return SensitiveLocal
	}
	return OutsideScope
}

// ValidateCandidatePaths rejects local, raw-evidence, and sensitive files that
// Git could commit in the governed areas. Canonical paths are also scanned for
// credential-like values; raw data is never read by this function.
func (p Policy) ValidateCandidatePaths(repositoryRoot string, paths []string) error {
	for _, path := range paths {
		classification := p.Classify(path)
		switch classification {
		case GeneratedLocal, ExternalEvidence, SensitiveLocal:
			return fmt.Errorf("%s is %s and must not be committed", normalize(path), classification)
		case Canonical:
			data, err := readCanonicalArtifact(repositoryRoot, normalize(path))
			if err != nil {
				return fmt.Errorf("%s: %w", normalize(path), err)
			}
			if err := rejectSecretContent(data); err != nil {
				return fmt.Errorf("%s: %w", normalize(path), err)
			}
			if matchesAny(normalize(path), p.ReferenceManifests) && strings.HasPrefix(normalize(path), "evidence/references/") {
				if err := ValidateEvidenceReference(data); err != nil {
					return fmt.Errorf("%s: %w", normalize(path), err)
				}
			}
		}
	}
	return nil
}

// readCanonicalArtifact rejects symlinks in every path component and verifies
// the resolved target is below the repository root before reading it.
func readCanonicalArtifact(repositoryRoot, relativePath string) ([]byte, error) {
	root, err := filepath.Abs(repositoryRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve repository root: %w", err)
	}
	relativePath = filepath.FromSlash(normalize(relativePath))
	if filepath.IsAbs(relativePath) {
		return nil, fmt.Errorf("canonical artifact path must be repository-relative")
	}
	candidate := filepath.Join(root, relativePath)
	rel, err := filepath.Rel(root, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("canonical artifact path escapes repository root")
	}
	current := root
	for _, component := range strings.Split(rel, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if err != nil {
			return nil, fmt.Errorf("inspect canonical artifact: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("canonical artifact path contains a symlink")
		}
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve repository root: %w", err)
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return nil, fmt.Errorf("resolve canonical artifact: %w", err)
	}
	resolvedRel, err := filepath.Rel(resolvedRoot, resolvedCandidate)
	if err != nil || resolvedRel == ".." || strings.HasPrefix(resolvedRel, ".."+string(filepath.Separator)) {
		return nil, fmt.Errorf("resolved canonical artifact escapes repository root")
	}
	data, err := os.ReadFile(resolvedCandidate)
	if err != nil {
		return nil, fmt.Errorf("read canonical artifact: %w", err)
	}
	return data, nil
}

func rejectSecretContent(data []byte) error {
	text := string(data)
	if strings.Contains(text, "-----BEGIN") && strings.Contains(text, "PRIVATE KEY-----") {
		return fmt.Errorf("private-key material is forbidden")
	}
	if secretValue.MatchString(text) || bearerValue.MatchString(text) {
		return fmt.Errorf("credential-like value is forbidden; store only a redacted reference")
	}
	return nil
}

func normalize(path string) string {
	path = filepath.ToSlash(filepath.Clean(path))
	return strings.TrimPrefix(path, "./")
}

func matchesAny(path string, patterns []string) bool {
	for _, pattern := range patterns {
		if matchPath(pattern, path) {
			return true
		}
	}
	return false
}

// matchPath supports slash-separated * and ** globs without importing a
// filesystem glob implementation. * does not cross a slash; ** does.
func matchPath(pattern, path string) bool {
	var expression strings.Builder
	expression.WriteString("^")
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '*':
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				expression.WriteString(".*")
				i++
			} else {
				expression.WriteString("[^/]*")
			}
		case '?':
			expression.WriteString("[^/]")
		default:
			expression.WriteString(regexp.QuoteMeta(string(pattern[i])))
		}
	}
	expression.WriteString("$")
	return regexp.MustCompile(expression.String()).MatchString(path)
}

// MetadataIndex is a deterministic, content-free index of canonical Wiki pages.
type MetadataIndex struct {
	SchemaVersion string      `json:"schema_version"`
	Pages         []IndexPage `json:"pages"`
}

type IndexPage struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

// RebuildMetadata produces only a local generated index from canonical Markdown.
// It never reads raw evidence, sessions, credentials, or tool output.
func (p Policy) RebuildMetadata(repositoryRoot string) (MetadataIndex, error) {
	wikiRoot := filepath.Join(repositoryRoot, ".llm-wiki", "wiki")
	index := MetadataIndex{SchemaVersion: "wiki-metadata-index/v1"}
	if err := filepath.WalkDir(wikiRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("cannot index symlinked wiki artifact %s", path)
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(repositoryRoot, path)
		if err != nil {
			return err
		}
		rel = normalize(rel)
		if p.Classify(rel) != Canonical {
			return fmt.Errorf("cannot index non-canonical wiki artifact %s", rel)
		}
		data, err := readCanonicalArtifact(repositoryRoot, rel)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		index.Pages = append(index.Pages, IndexPage{Path: rel, SHA256: hex.EncodeToString(sum[:])})
		return nil
	}); err != nil {
		return MetadataIndex{}, fmt.Errorf("walk canonical wiki pages: %w", err)
	}
	sort.Slice(index.Pages, func(i, j int) bool { return index.Pages[i].Path < index.Pages[j].Path })
	data, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return MetadataIndex{}, fmt.Errorf("encode metadata index: %w", err)
	}
	path := filepath.Join(repositoryRoot, ".llm-wiki", "meta", "registry.json")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return MetadataIndex{}, fmt.Errorf("create metadata directory: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0644); err != nil {
		return MetadataIndex{}, fmt.Errorf("write generated metadata: %w", err)
	}
	return index, nil
}

type Inventory struct {
	SchemaVersion string         `json:"schema_version"`
	Counts        map[string]int `json:"counts"`
}

// InventoryRepository counts classifications without reading or emitting file
// contents or individual paths. It is safe to use on a local vault before any
// migration or sharing decision.
func (p Policy) InventoryRepository(repositoryRoot string) (Inventory, error) {
	inventory := Inventory{SchemaVersion: "wiki-governance-inventory/v1", Counts: map[string]int{}}
	for _, topLevel := range []string{".llm-wiki", ".pi", "docs", "evidence"} {
		root := filepath.Join(repositoryRoot, topLevel)
		if _, err := os.Lstat(root); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return Inventory{}, err
		}
		if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(repositoryRoot, path)
			if err != nil {
				return err
			}
			class := p.Classify(rel)
			if class != OutsideScope {
				inventory.Counts[string(class)]++
			}
			return nil
		}); err != nil {
			return Inventory{}, err
		}
	}
	return inventory, nil
}
