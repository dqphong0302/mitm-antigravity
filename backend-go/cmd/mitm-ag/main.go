package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"mitm-antigravity/backend-go/internal/config"
)

var version = "go-prototype"

func main() {
	if len(os.Args) < 2 {
		printHelp()
		return
	}

	switch os.Args[1] {
	case "--help", "-h", "help":
		printHelp()
	case "version":
		fmt.Println(version)
	case "config":
		runConfig(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		printHelp()
		os.Exit(2)
	}
}

func printHelp() {
	fmt.Print(`mitm-ag Go backend prototype

Usage:
  mitm-ag help
  mitm-ag version
  mitm-ag config --json

This prototype currently covers model/config compatibility only.
Full proxy, certificate, DNS, and process-control parity will be added in later phases.
`)
}

func runConfig(args []string) {
	fs := flag.NewFlagSet("config", flag.ExitOnError)
	jsonOutput := fs.Bool("json", false, "print resolved config as JSON")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	cfg, err := config.ReadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "read config: %v\n", err)
		os.Exit(1)
	}

	if *jsonOutput {
		encoded, err := json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "encode config: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(string(encoded))
		return
	}

	fmt.Printf("routerUrl=%s\n", cfg.RouterURL)
	fmt.Printf("port=%d\n", cfg.Port)
	fmt.Printf("targetHost=%s\n", config.PrimaryTargetHost(cfg))
	fmt.Printf("mappedModels=%d\n", len(cfg.ModelMap))
}
