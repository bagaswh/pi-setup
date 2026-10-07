package main

import (
	"fmt"
	"os"
	"syscall"
)

// handoff replaces the current process image with pi via syscall.Exec.
// This keeps behavior identical to a direct `pi` launch: same PID, same
// process group, same TTY ownership, no wrapper process intercepting
// signals or waiting on the child.
//
// The temp enforcement file is read by pi during startup (resource load,
// before the first prompt); cleanup of stale files happens on the next pil
// run, not here, because after exec this code no longer exists.
func handoff(bin string, args []string) error {
	err := syscall.Exec(bin, append([]string{bin}, args...), os.Environ())
	if err != nil {
		return fmt.Errorf("cannot exec pi: %w", err)
	}
	return nil
}
