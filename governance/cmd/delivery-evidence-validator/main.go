// delivery-evidence-validator validates delivery evidence and acceptance
// contracts offline. It never contacts GitHub, Linear, or a signing service.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/zkrausman/pi-sampler/governance/pkg/deliveryevidence"
)

func main() {
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
		err = deliveryevidence.ValidateAcceptanceBundle(*acceptanceManifest, *acceptanceMatrix, *root, *expectedRepository, *expectedBase, *expectedHead, *expectedPR, *trustedConfig, *replayState)
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

func usageError(message string) {
	fmt.Fprintln(os.Stderr, message)
	flag.PrintDefaults()
	os.Exit(2)
}
