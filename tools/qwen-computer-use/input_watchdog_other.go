//go:build !windows

package main

type inputWatchdog struct{}

func watchInput(pid int) (*inputWatchdog, error) { return &inputWatchdog{}, nil }
func (w *inputWatchdog) close()                  {}
