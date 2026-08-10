// wiki-governance validates the shared Wiki/OKF Git boundary without accessing
// a network, external evidence store, credentials, raw evidence, or telemetry.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/zkrausman/pi-sampler/governance/pkg/wikigovernance"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "validate":
		repoRoot := requiredRoot("validate")
		policy, err := wikigovernance.LoadPolicy(repoRoot)
		if err == nil {
			err = policy.ValidateRepository(repoRoot)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "wiki-governance validation failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("wiki-governance validation passed")
	case "rebuild":
		repoRoot := requiredRoot("rebuild")
		policy, err := wikigovernance.LoadPolicy(repoRoot)
		if err == nil {
			_, err = policy.RebuildMetadata(repoRoot)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "wiki-governance rebuild failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("wiki-governance metadata rebuild passed")
	case "inventory":
		flags := flag.NewFlagSet("inventory", flag.ExitOnError)
		repoRoot := flags.String("repo-root", ".", "repository root containing the local vault")
		policyRoot := flags.String("policy-root", "", "optional repository root supplying a reviewed path policy")
		output := flags.String("output", "", "optional aggregate-only report path")
		_ = flags.Parse(os.Args[2:])
		root, err := filepath.Abs(*repoRoot)
		if err != nil {
			fatal(err)
		}
		loadRoot := root
		if *policyRoot != "" {
			loadRoot, err = filepath.Abs(*policyRoot)
			if err != nil {
				fatal(err)
			}
		}
		policy, err := wikigovernance.LoadPolicy(loadRoot)
		if err == nil {
			inventory, inventoryErr := policy.InventoryRepository(root)
			if inventoryErr != nil {
				err = inventoryErr
			} else {
				report := wikigovernance.FormatInventory(inventory)
				if *output != "" {
					if err = os.WriteFile(*output, []byte(report), 0644); err == nil {
						fmt.Printf("aggregate-only inventory written to %s\n", *output)
					}
				} else {
					fmt.Print(report)
				}
			}
		}
		if err != nil {
			fatal(err)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func requiredRoot(command string) string {
	flags := flag.NewFlagSet(command, flag.ExitOnError)
	repoRoot := flags.String("repo-root", ".", "repository root")
	_ = flags.Parse(os.Args[2:])
	root, err := filepath.Abs(*repoRoot)
	if err != nil {
		fatal(err)
	}
	return root
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: wiki-governance <validate|rebuild|inventory> -repo-root <repository-root>")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
