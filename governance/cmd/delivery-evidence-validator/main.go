// delivery-evidence-validator validates a committed delivery evidence manifest offline.
package main

import (
	"flag"
	"fmt"
	"github.com/zkrausman/pi-sampler/governance/pkg/deliveryevidence"
	"os"
)

func main() {
	manifest := flag.String("manifest", "", "path to delivery evidence JSON manifest")
	root := flag.String("repo-root", ".", "repository root containing the OKF artifact")
	expectedCommit := flag.String("expected-commit", "", "required immutable delivery commit SHA selected by CI")
	flag.Parse()
	if *manifest == "" || *expectedCommit == "" {
		fmt.Fprintln(os.Stderr, "-manifest and -expected-commit are required")
		os.Exit(2)
	}
	if err := deliveryevidence.ValidateFileAtCommit(*manifest, *root, *expectedCommit); err != nil {
		fmt.Fprintln(os.Stderr, "invalid delivery evidence:", err)
		os.Exit(1)
	}
	fmt.Println("delivery evidence valid")
}
