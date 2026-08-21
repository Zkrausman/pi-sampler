package deliveryevidence

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dlclark/regexp2"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

const publishedDeliveryEvidenceSchemaDirectory = "governance/docs/delivery-evidence"

type deliveryEvidenceRegexp regexp2.Regexp

func (re *deliveryEvidenceRegexp) MatchString(value string) bool {
	matched, err := (*regexp2.Regexp)(re).MatchString(value)
	return err == nil && matched
}

func (re *deliveryEvidenceRegexp) String() string {
	return (*regexp2.Regexp)(re).String()
}

func compileDeliveryEvidenceRegexp(pattern string) (jsonschema.Regexp, error) {
	re, err := regexp2.Compile(pattern, regexp2.ECMAScript)
	if err != nil {
		return nil, err
	}
	return (*deliveryEvidenceRegexp)(re), nil
}

// publishedSchemaPath resolves only the checked-in schema boundary. When a
// caller supplies a repository root, the schema must be present under that
// root; the fallback search is only for package-level compatibility callers
// that do not yet supply a root.
func publishedSchemaPath(repositoryRoot, schemaName string) (string, error) {
	if schemaName == "" || filepath.Base(schemaName) != schemaName {
		return "", fmt.Errorf("published schema name is invalid")
	}
	candidates := make([]string, 0, 8)
	if repositoryRoot != "" {
		root, err := filepath.Abs(repositoryRoot)
		if err != nil {
			return "", fmt.Errorf("resolve repository root for published schema: %w", err)
		}
		candidates = append(candidates,
			filepath.Join(root, publishedDeliveryEvidenceSchemaDirectory, schemaName),
			filepath.Join(root, "docs", "delivery-evidence", schemaName),
		)
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("resolve working directory for published schema: %w", err)
		}
		for current := cwd; ; current = filepath.Dir(current) {
			candidates = append(candidates,
				filepath.Join(current, publishedDeliveryEvidenceSchemaDirectory, schemaName),
				filepath.Join(current, "docs", "delivery-evidence", schemaName),
			)
			parent := filepath.Dir(current)
			if parent == current {
				break
			}
		}
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("published delivery-evidence schema %s is unavailable", schemaName)
}

func validatePublishedSchema(repositoryRoot, schemaName string, data []byte, label string) error {
	schemaPath, err := publishedSchemaPath(repositoryRoot, schemaName)
	if err != nil {
		return err
	}
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("read published schema %s: %w", schemaName, err)
	}
	if len(schemaBytes) > maxAcceptanceJSONBytes {
		return fmt.Errorf("published schema %s exceeds its bounded size", schemaName)
	}
	var schemaDocument any
	if err := decodeStrictJSON(schemaBytes, &schemaDocument); err != nil {
		return fmt.Errorf("decode published schema %s: %w", schemaName, err)
	}
	var instance any
	if err := decodeStrictJSON(data, &instance); err != nil {
		return fmt.Errorf("decode %s for published schema validation: %w", label, err)
	}
	// Re-decode through the standard JSON representation after the duplicate-key
	// and resource checks above. Measured contract values are below 2^53; the
	// larger variance ceiling is a power of two and remains exactly representable.
	if err := json.Unmarshal(data, &instance); err != nil {
		return fmt.Errorf("decode %s for published schema validation: %w", label, err)
	}
	resource := "https://pi-sampler.dev/delivery-evidence/" + schemaName
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	compiler.UseRegexpEngine(compileDeliveryEvidenceRegexp)
	if err := compiler.AddResource(resource, schemaDocument); err != nil {
		return fmt.Errorf("load published schema %s: %w", schemaName, err)
	}
	schema, err := compiler.Compile(resource)
	if err != nil {
		return fmt.Errorf("compile published schema %s: %w", schemaName, err)
	}
	if err := schema.Validate(instance); err != nil {
		return fmt.Errorf("%s does not match published schema %s: %w", label, schemaName, err)
	}
	return nil
}
