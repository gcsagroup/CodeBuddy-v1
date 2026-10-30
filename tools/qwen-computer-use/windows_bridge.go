package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// One bridge per MCP connection amortizes PowerShell and Add-Type startup.
// Only code is retained: every operation resolves and observes live windows.
type windowsBridge struct {
	mu         sync.Mutex
	cmd        *exec.Cmd
	in         io.WriteCloser
	out        *bufio.Reader
	directory  string
	guard      *inputWatchdog
	leaseTimer *time.Timer
}

func (b *windowsBridge) start() error {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		return errors.New("Windows bridge requires Windows")
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		cmd = exec.Command(filepath.Join(filepath.Dir(executable), "qwen-computer-runtime"), "--stream")
	} else {
		dir, err := os.MkdirTemp("", "codebuddy-desktop-bridge-*")
		if err != nil {
			return err
		}
		b.directory = dir
		for name, content := range map[string]string{"runtime.ps1": windowsRuntimeScript, "desktop-input.cs": desktopInputSource, "desktop-feedback.cs": desktopFeedbackSource} {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
				b.reset()
				return err
			}
		}
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(dir, "runtime.ps1"), "-Stream")
	}
	hideRuntimeWindow(cmd)
	in, err := cmd.StdinPipe()
	if err != nil {
		b.reset()
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		b.reset()
		return err
	}
	// Keep diagnostics off the framed response channel.
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		in.Close()
		out.Close()
		b.reset()
		return err
	}
	b.cmd, b.in, b.out = cmd, in, bufio.NewReader(out)
	guard, err := watchInput(cmd.Process.Pid)
	if err != nil {
		b.reset()
		return err
	}
	b.guard = guard
	return nil
}

func (b *windowsBridge) reset() {
	if b.leaseTimer != nil {
		b.leaseTimer.Stop()
		b.leaseTimer = nil
	}
	if b.in != nil {
		_ = b.in.Close()
	}
	if b.cmd != nil {
		_ = b.cmd.Process.Kill()
		_ = b.cmd.Wait()
	}
	if b.guard != nil {
		b.guard.close()
		b.guard = nil
	}
	if b.directory != "" {
		_ = os.RemoveAll(b.directory)
	}
	b.cmd, b.in, b.out, b.directory = nil, nil, nil, ""
}

func (b *windowsBridge) close() { b.mu.Lock(); defer b.mu.Unlock(); b.reset() }

// ScreenCaptureKit can retain capture resources for the worker's lifetime.
// Retire an idle Mac worker when its host lease ends, before another chat captures.
// The mutex keeps cleanup out of an in-flight action; no request is replayed.
func (b *windowsBridge) watchMacLease(request psRequest) {
	if runtime.GOOS != "darwin" || b.cmd == nil || request.ControlDirectory == "" {
		return
	}
	if b.leaseTimer != nil {
		b.leaseTimer.Stop()
	}
	worker := b.cmd
	var timer *time.Timer
	timer = time.AfterFunc(100*time.Millisecond, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.cmd != worker || b.leaseTimer != timer {
			return
		}
		identity, err := os.ReadFile(filepath.Join(request.ControlDirectory, "lease.json"))
		_, paused := os.Stat(filepath.Join(request.ControlDirectory, "paused"))
		if err != nil || string(identity) != request.ControlIdentity || !os.IsNotExist(paused) {
			b.reset()
			return
		}
		b.watchMacLease(request)
	})
	b.leaseTimer = timer
}

func (b *windowsBridge) call(parent context.Context, request psRequest) (*psResponse, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	defer b.watchMacLease(request)
	if err := parent.Err(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	if b.cmd == nil {
		if err := b.start(); err != nil {
			return nil, err
		}
	}
	if err := ctx.Err(); err != nil {
		b.reset()
		return nil, err
	}
	type reply struct {
		response *psResponse
		err      error
	}
	done := make(chan reply, 1)
	in, out := b.in, b.out
	go func() {
		if err := json.NewEncoder(in).Encode(request); err != nil {
			done <- reply{err: err}
			return
		}
		line, err := out.ReadBytes('\n')
		if err != nil {
			done <- reply{err: err}
			return
		}
		var response psResponse
		err = json.Unmarshal(line, &response)
		done <- reply{response: &response, err: err}
	}()
	select {
	case result := <-done:
		if result.err == nil {
			return result.response, nil
		}
		pauseDesktopBridge(request)
		b.reset()
		return nil, fmt.Errorf("Desktop bridge interrupted: %w; action outcome unknown, observe before retrying", result.err)
	case <-ctx.Done():
		// Never replay a request: the input may already have reached the app.
		if request.ControlDirectory != "" {
			pauseDesktopBridge(request)
			// Give cooperative input its finally cleanup before terminating a hung
			// UIA worker. This grace period is only on cancellation, never normal input.
			select {
			case <-done:
				b.reset()
				return nil, fmt.Errorf("Desktop bridge interrupted: %w; do not replay uncertain input; continue independent non-desktop work", ctx.Err())
			case <-time.After(1500 * time.Millisecond):
			}
		}
		b.reset()
		<-done
		return nil, fmt.Errorf("Desktop bridge interrupted: %w; action outcome unknown, observe before retrying", ctx.Err())
	}
}

func pauseDesktopBridge(request psRequest) {
	if request.ControlDirectory == "" {
		return
	}
	marker, err := os.OpenFile(filepath.Join(request.ControlDirectory, "paused"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err == nil {
		_, _ = marker.WriteString(fmt.Sprintf("native-%d-%d", os.Getpid(), time.Now().UnixNano()))
		_ = marker.Close()
	}
}
