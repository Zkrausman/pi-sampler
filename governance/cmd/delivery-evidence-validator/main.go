// delivery-evidence-validator validates delivery evidence and acceptance
// contracts offline. It never contacts GitHub, Linear, or a signing service.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/zkrausman/pi-sampler/governance/pkg/deliveryevidence"
)

func main() {
	if hasAcceptanceV2Mode(os.Args[1:]) {
		validateAcceptanceV2Args(os.Args[1:])
	}
	mode := flag.String("mode", "delivery", "validation mode: delivery, manifest, acceptance, benchmark, or waiver")
	manifest := flag.String("manifest", "", "path to the legacy delivery evidence JSON manifest")
	acceptanceManifest := flag.String("acceptance-manifest", "", "path to the approved-plan acceptance manifest")
	acceptanceMatrix := flag.String("acceptance-matrix", "", "path to the observed/waived/blocked acceptance matrix")
	benchmark := flag.String("benchmark-evidence", "", "path to benchmark evidence JSON")
	waiver := flag.String("waiver", "", "path to a consumer-supplied signed waiver JSON")
	root := flag.String("repo-root", ".", "candidate repository root")
	expectedCommit := flag.String("expected-commit", "", "required immutable delivery commit SHA selected by CI")
	expectedRepository := flag.String("expected-repository", "", "trusted repository identity")
	expectedTicket := flag.String("expected-ticket", "", "trusted ticket identity")
	expectedRow := flag.String("expected-row", "", "trusted acceptance row identity")
	expectedPlan := flag.String("expected-plan", "", "trusted plan SHA-256 digest")
	expectedBase := flag.String("expected-base", "", "trusted immutable base SHA")
	expectedHead := flag.String("expected-head", "", "trusted immutable candidate head SHA")
	expectedPR := flag.Int("expected-pr", 0, "trusted pull request number")
	benchmarkClass := flag.String("benchmark-class", "", "expected benchmark class: local-10m or ci-regression")
	trustedConfig := flag.String("trusted-config", "", "consumer-owned trusted waiver public-key configuration")
	replayState := flag.String("replay-state", "", "consumer-owned single-use waiver replay state")
	flag.Parse()

	if *mode == "acceptance-v2" {
		validateAcceptanceV2CLI()
	}

	var err error
	switch *mode {
	case "delivery", "legacy":
		if *manifest == "" || *expectedCommit == "" {
			usageError("-manifest and -expected-commit are required in delivery mode")
		}
		err = deliveryevidence.ValidateFileAtCommit(*manifest, *root, *expectedCommit)
	case "manifest", "acceptance-manifest":
		if *acceptanceManifest == "" || *expectedRepository == "" || *expectedBase == "" {
			usageError("-acceptance-manifest, -expected-repository, and -expected-base are required in manifest mode")
		}
		err = deliveryevidence.ValidateAcceptanceManifestFile(*acceptanceManifest, *root, *expectedRepository, *expectedBase)
	case "acceptance", "matrix":
		if *acceptanceManifest == "" || *acceptanceMatrix == "" || *expectedRepository == "" || *expectedBase == "" || *expectedHead == "" || *expectedPR < 1 {
			usageError("acceptance mode requires acceptance manifest/matrix, repository, base/head, and pull request bindings")
		}
		if pair, pairErr := deliveryevidence.ClassifyAcceptanceVersionPairFiles(*acceptanceMatrix, *acceptanceManifest); pairErr == nil && pair != "v1/v1" {
			err = fmt.Errorf("acceptance version pair %s is not admitted by the frozen v1 CLI", pair)
		} else {
			// Exact v1/v1 continues through the unchanged frozen bundle API;
			// a missing/unreadable pair retains the legacy validator error.
			err = deliveryevidence.ValidateAcceptanceBundle(*acceptanceManifest, *acceptanceMatrix, *root, *expectedRepository, *expectedBase, *expectedHead, *expectedPR, *trustedConfig, *replayState)
		}
	case "benchmark":
		if *benchmark == "" || *expectedRepository == "" || *expectedBase == "" || *expectedHead == "" {
			usageError("benchmark mode requires benchmark evidence, repository, base, and head bindings")
		}
		err = deliveryevidence.ValidateBenchmarkEvidenceFileAt(*benchmark, *root, *expectedRepository, *expectedBase, *expectedHead, *benchmarkClass)
	case "waiver":
		if *waiver == "" || *trustedConfig == "" || *replayState == "" || *expectedRepository == "" || *expectedTicket == "" || *expectedRow == "" || *expectedPlan == "" || *expectedBase == "" || *expectedHead == "" || *expectedPR < 1 {
			usageError("waiver mode requires waiver, trusted-config, replay-state, and complete repository/ticket/row/plan/base/head/PR bindings")
		}
		err = deliveryevidence.ValidateWaiverFile(*waiver, *trustedConfig, *replayState, *root, *expectedRepository, *expectedTicket, *expectedRow, *expectedPlan, *expectedBase, *expectedHead, *expectedPR)
	default:
		usageError("unknown validation mode")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid delivery evidence:", err)
		os.Exit(1)
	}
	fmt.Println("delivery evidence valid")
}

func hasAcceptanceV2Mode(args []string) bool {
	for index := 0; index < len(args); index++ {
		if (args[index] == "-mode" || args[index] == "--mode") && index+1 < len(args) && args[index+1] == "acceptance-v2" {
			return true
		}
		modeValue := ""
		if strings.HasPrefix(args[index], "-mode=") {
			modeValue = strings.TrimPrefix(args[index], "-mode=")
		}
		if strings.HasPrefix(args[index], "--mode=") {
			modeValue = strings.TrimPrefix(args[index], "--mode=")
		}
		if modeValue == "acceptance-v2" {
			return true
		}
	}
	return false
}

func validateAcceptanceV2Args(args []string) {
	seenMode := false
	for index := 0; index < len(args); index++ {
		if args[index] != "-mode" {
			usageError("acceptance-v2 accepts only the exact -mode acceptance-v2 argv")
		}
		if seenMode || index+1 >= len(args) || args[index+1] != "acceptance-v2" {
			usageError("acceptance-v2 requires one exact -mode acceptance-v2 pair")
		}
		seenMode = true
		index++
	}
	if !seenMode {
		usageError("acceptance-v2 requires one exact -mode acceptance-v2 pair")
	}
}

func validateAcceptanceV2CLI() {
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 12*1024*1024+1))
	if err != nil || len(data) > 12*1024*1024 {
		fmt.Fprintln(os.Stderr, "acceptance-v2 request is unavailable or oversized")
		os.Exit(2)
	}
	request, err := deliveryevidence.DecodeAcceptanceV2Request(data)
	if err != nil {
		fmt.Fprintln(os.Stderr, "acceptance-v2 request is invalid")
		os.Exit(2)
	}
	exclusions := []string{}
	if encoded := os.Getenv("PI_SAMPLER_DELIVERY_V2_EXCLUSIONS"); encoded != "" {
		if err := json.Unmarshal([]byte(encoded), &exclusions); err != nil || len(exclusions) > 64 {
			fmt.Fprintln(os.Stderr, "acceptance-v2 exclusions are invalid")
			os.Exit(2)
		}
		for _, exclusion := range exclusions {
			if exclusion == "" {
				fmt.Fprintln(os.Stderr, "acceptance-v2 exclusions are invalid")
				os.Exit(2)
			}
		}
	}
	result := deliveryevidence.ValidateAcceptanceV2WithExclusions(request, exclusions)
	_, _ = os.Stdout.Write(acceptanceResultBytes(result))
	if result.Status == "blocked" {
		os.Exit(3)
	}
	if result.Status != "valid" {
		os.Exit(1)
	}
	os.Exit(0)
}

func acceptanceResultBytes(result deliveryevidence.AcceptanceResultV1) []byte {
	// MarshalJSON is the frozen result-envelope ordering; add exactly one LF
	// for the line-oriented controller protocol.
	data, err := result.MarshalJSON()
	if err != nil {
		return []byte(`{"format":"pi-sampler.delivery-acceptance-result","version":1,"status":"invalid","code":"usage_invalid","evaluation_scope":"","facts_sha256":"0000000000000000000000000000000000000000000000000000000000000000","matrix_sha256":"0000000000000000000000000000000000000000000000000000000000000000","rows":[],"diagnostics":[]}` + "\n")
	}
	return append(data, '\n')
}

func usageError(message string) {
	fmt.Fprintln(os.Stderr, message)
	flag.PrintDefaults()
	os.Exit(2)
}
