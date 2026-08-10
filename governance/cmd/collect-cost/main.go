// cmd/collect-cost enriches a delivery evidence manifest with harness cost metadata (WORK-123).
// Offline, deterministic, no network. Reads git author email and patches the manifest.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/zkrausman/pi-sampler/governance/pkg/deliveryevidence"
)

func main() {
	manifest := flag.String("manifest", "", "path to evidence/delivery/WORK-XXX.json")
	provider := flag.String("provider", "", "harness provider id")
	model := flag.String("model", "", "model id")
	thinking := flag.String("thinkingLevel", "", "thinking level")
	harnessType := flag.String("harnessType", "", "pi|jules")
	elapsedMs := flag.Int64("elapsedMs", -1, "elapsed milliseconds")
	email := flag.String("email", "", "git author email (default: git log -1 --pretty=format:%ae)")
	dryRun := flag.Bool("dry-run", false, "print enriched manifest without writing")
	flag.Parse()
	if *manifest == "" {
		fmt.Fprintln(os.Stderr, "-manifest is required")
		os.Exit(2)
	}
	resolvedEmail := strings.TrimSpace(*email)
	if resolvedEmail == "" {
		out, err := exec.Command("git", "log", "-1", "--pretty=format:%ae").Output()
		if err == nil && strings.TrimSpace(string(out)) != "" {
			resolvedEmail = strings.TrimSpace(string(out))
		} else {
			out2, err2 := exec.Command("git", "config", "user.email").Output()
			if err2 == nil {
				resolvedEmail = strings.TrimSpace(string(out2))
			}
		}
	}
	if resolvedEmail == "" {
		fmt.Fprintln(os.Stderr, "cannot resolve git author email; pass -email")
		os.Exit(2)
	}
	devID := deliveryevidence.DeveloperIDForEmail(resolvedEmail)
	data, err := os.ReadFile(*manifest)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read manifest: %v\n", err)
		os.Exit(1)
	}
	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		fmt.Fprintf(os.Stderr, "parse manifest: %v\n", err)
		os.Exit(1)
	}
	harness, _ := doc["harness"].(map[string]any)
	if harness == nil {
		harness = map[string]any{}
	}
	if *provider != "" {
		harness["provider"] = *provider
	}
	if *model != "" {
		harness["model"] = *model
	}
	if *thinking != "" {
		harness["thinkingLevel"] = *thinking
	}
	if *harnessType != "" {
		harness["harnessType"] = *harnessType
	}
	if *elapsedMs >= 0 {
		harness["elapsedMs"] = *elapsedMs
	}
	harness["developer_id"] = devID
	// Redaction: refuse to enrich if harness already contains raw PII-like values
	harnessJSON, _ := json.Marshal(harness)
	if strings.Contains(string(harnessJSON), "@") {
		// developer_id is hashed, so any @ indicates raw email leaked
		// But developer_id itself is sha256:<hex> and contains no @, so this is a leak
		fmt.Fprintln(os.Stderr, "redaction: harness contains raw email/PII")
		os.Exit(1)
	}
	doc["harness"] = harness
	out, _ := json.MarshalIndent(doc, "", "  ")
	out = append(out, '\n')
	if *dryRun {
		os.Stdout.Write(out)
		return
	}
	if err := os.WriteFile(*manifest, out, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "write manifest: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("enriched %s developer_id=%s\n", *manifest, devID)
}
