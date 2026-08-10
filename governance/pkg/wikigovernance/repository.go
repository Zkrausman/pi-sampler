package wikigovernance

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// ValidateRepository enforces both the path policy and its Git-ignore boundary.
// Candidate files include tracked files and unignored untracked files, so a local
// pre-commit invocation also catches an unsafe new artifact before staging.
func (p Policy) ValidateRepository(repositoryRoot string) error {
	if err := validateIgnoreRules(repositoryRoot, p); err != nil {
		return err
	}
	paths, err := committablePaths(repositoryRoot)
	if err != nil {
		return err
	}
	if err := p.ValidateCandidatePaths(repositoryRoot, paths); err != nil {
		return err
	}
	return nil
}

func committablePaths(repositoryRoot string) ([]string, error) {
	command := exec.Command("git", "-C", repositoryRoot, "ls-files", "-co", "--exclude-standard", "-z")
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("list committable paths: %w", err)
	}
	var paths []string
	for _, path := range bytes.Split(output, []byte{0}) {
		if len(path) > 0 {
			paths = append(paths, filepath.ToSlash(string(path)))
		}
	}
	return paths, nil
}

func validateIgnoreRules(repositoryRoot string, policy Policy) error {
	for _, pattern := range policy.CleanCloneAbsent {
		path := samplePath(pattern)
		if err := checkIgnored(repositoryRoot, path, true); err != nil {
			return err
		}
	}
	for _, pattern := range policy.Canonical {
		path := samplePath(pattern)
		if err := checkIgnored(repositoryRoot, path, false); err != nil {
			return err
		}
	}
	return nil
}

func samplePath(pattern string) string {
	path := strings.ReplaceAll(pattern, "**", "sample/nested")
	path = strings.ReplaceAll(path, "*", "sample")
	path = strings.ReplaceAll(path, "?", "x")
	return path
}

func checkIgnored(repositoryRoot, path string, expected bool) error {
	command := exec.Command("git", "-C", repositoryRoot, "check-ignore", "-q", "--", path)
	err := command.Run()
	ignored := err == nil
	if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() != 1 {
		return fmt.Errorf("check ignore rule for %s: %w", path, err)
	}
	if ignored != expected {
		state := "ignored"
		if expected {
			state = "not ignored"
		}
		return fmt.Errorf("Git ignore boundary unsafe: %s is %s", path, state)
	}
	return nil
}

// FormatInventory renders stable aggregate-only migration output. It deliberately
// omits file names and content so it cannot disclose a local packet or secret.
func FormatInventory(inventory Inventory) string {
	var keys []string
	for key := range inventory.Counts {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	builder.WriteString("# Local vault migration inventory\n\n")
	builder.WriteString("This inventory is aggregate-only: it classifies every governed local artifact without reading, copying, or listing its content or path.\n\n")
	builder.WriteString("| Classification | Artifact count | Migration action |\n| --- | ---: | --- |\n")
	for _, key := range keys {
		action := migrationAction(Classification(key))
		fmt.Fprintf(&builder, "| `%s` | %d | %s |\n", key, inventory.Counts[key], action)
	}
	builder.WriteString("\nNo raw evidence, credentials, session state, tool output, or individual source-packet paths are present in this report.\n")
	return builder.String()
}

func migrationAction(class Classification) string {
	switch class {
	case Canonical:
		return "Review for redaction, then share through Git."
	case GeneratedLocal:
		return "Regenerate locally; do not commit."
	case ExternalEvidence:
		return "Keep outside Git; record only immutable ID/digest reference after an approved store is available."
	case SensitiveLocal:
		return "Do not share or commit; rotate/escalate if exposure is suspected."
	default:
		return "Out of scope."
	}
}
