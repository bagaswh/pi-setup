package main

import (
	"fmt"
	"strings"
)

// cliOptions holds pil's own flags, separated from args forwarded to pi.
type cliOptions struct {
	rest        []string            // forwarded to pi verbatim
	pilSkills   []string            // --pil-skill values
	preambles   map[string]string   // --pil-preamble values (skill name -> text)
	files       map[string][]string // --pil-file values (skill name -> glob patterns)
	configPath  string              // --pil-config
	listSkills  bool                // --pil-list-skills
	dryRun      bool                // --pil-dry-run
	noPins      bool                // --pil-no-pins
	help        bool                // --pil-help
	showVersion bool                // --pil-version
}

// parseArgs splits argv into pil flags (consumed) and the rest (forwarded to
// pi verbatim). Arguments after a bare "--" always go to pi untouched, so
// "pil -p -- '- Summarize this'" keeps pi's prompt-leading-with-dash
// semantics intact.
func parseArgs(argv []string) (cliOptions, error) {
	var opts cliOptions
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		switch {
		case arg == "--":
			opts.rest = append(opts.rest, argv[i:]...)
			return opts, nil
		case arg == "--pil-skill":
			if i+1 >= len(argv) {
				return opts, fmt.Errorf("--pil-skill needs a value")
			}
			i++
			opts.pilSkills = append(opts.pilSkills, argv[i])
		case arg == "--pil-preamble":
			if i+1 >= len(argv) {
				return opts, fmt.Errorf("--pil-preamble needs a value: <skill>=<text>")
			}
			i++
			name, text, ok := strings.Cut(argv[i], "=")
			if !ok {
				return opts, fmt.Errorf("--pil-preamble wants <skill>=<text>, got %q", argv[i])
			}
			name = strings.TrimSpace(name)
			if name == "" {
				return opts, fmt.Errorf("--pil-preamble skill name is empty in %q", argv[i])
			}
			if opts.preambles == nil {
				opts.preambles = map[string]string{}
			}
			opts.preambles[name] = text
		case arg == "--pil-file":
			if i+1 >= len(argv) {
				return opts, fmt.Errorf("--pil-file needs a value: <skill>=<glob>")
			}
			i++
			name, glob, ok := strings.Cut(argv[i], "=")
			if !ok {
				return opts, fmt.Errorf("--pil-file wants <skill>=<glob>, got %q", argv[i])
			}
			name = strings.TrimSpace(name)
			glob = strings.TrimSpace(glob)
			if name == "" || glob == "" {
				return opts, fmt.Errorf("--pil-file wants <skill>=<glob>, got %q", argv[i])
			}
			if opts.files == nil {
				opts.files = map[string][]string{}
			}
			opts.files[name] = append(opts.files[name], glob)
		case arg == "--pil-config":
			if i+1 >= len(argv) {
				return opts, fmt.Errorf("--pil-config needs a value")
			}
			i++
			opts.configPath = argv[i]
		case arg == "--pil-list-skills":
			opts.listSkills = true
		case arg == "--pil-dry-run":
			opts.dryRun = true
		case arg == "--pil-no-pins":
			opts.noPins = true
		case arg == "--pil-help", arg == "-h", arg == "help":
			opts.help = true
			return opts, nil
		case arg == "--pil-version":
			opts.showVersion = true
			return opts, nil
		default:
			opts.rest = append(opts.rest, arg)
		}
	}
	return opts, nil
}
