// planning-rubric-validator validates a committed planning rubric artifact offline.
package main

import (
	"flag"
	"fmt"
	"github.com/zkrausman/pi-sampler/governance/pkg/planningrubric"
	"os"
)

func main() {
	manifest := flag.String("manifest", "", "path to planning rubric JSON artifact")
	root := flag.String("repo-root", ".", "repository root for path containment checks")
	flag.Parse()
	if *manifest == "" {
		fmt.Fprintln(os.Stderr, "-manifest is required")
		os.Exit(2)
	}
	if err := planningrubric.ValidateFile(*manifest, *root); err != nil {
		fmt.Fprintln(os.Stderr, "invalid planning rubric:", err)
		os.Exit(1)
	}
	fmt.Println("planning rubric valid")
}
