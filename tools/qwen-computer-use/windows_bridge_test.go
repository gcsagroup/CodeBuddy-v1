package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMacIdleWorkerRetiresAtLeaseBoundary(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Mac capture lifecycle")
	}
	dir := t.TempDir()
	lease := filepath.Join(dir, "lease.json")
	if err := os.WriteFile(lease, []byte("first"), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	b := &windowsBridge{cmd: cmd}
	defer b.close()
	b.mu.Lock()
	b.watchMacLease(psRequest{ControlDirectory: dir, ControlIdentity: "first"})
	// The next request can renew ownership before an old timer acquires the lock.
	if err := os.WriteFile(lease, []byte("second"), 0600); err != nil {
		b.mu.Unlock()
		t.Fatal(err)
	}
	b.watchMacLease(psRequest{ControlDirectory: dir, ControlIdentity: "second"})
	b.mu.Unlock()
	time.Sleep(250 * time.Millisecond)
	b.mu.Lock()
	alive := b.cmd == cmd
	b.mu.Unlock()
	if !alive {
		t.Fatal("stale lease timer retired the current worker")
	}
	if err := os.Remove(lease); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		retired := b.cmd == nil
		b.mu.Unlock()
		if retired {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("ended lease retained native capture resources")
}

func TestWindowsBridgeReusesWorkerAndRecoversWithoutReplay(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows bridge")
	}
	t.Setenv("OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH", "0")
	b := &windowsBridge{}
	defer b.close()
	request := psRequest{Tool: "get_app_state", App: "OCU_missing_中文_🙂_29b45e"}
	for i := 0; i < 2; i++ {
		response, err := b.call(context.Background(), request)
		if err != nil || response.OK || !strings.Contains(response.Error, request.App) {
			t.Fatalf("fresh error/Unicode lost: %v %#v", err, response)
		}
		if i == 0 {
			t.Logf("worker pid=%d", b.cmd.Process.Pid)
		}
	}
	pid := b.cmd.Process.Pid
	directory := b.directory
	if _, err := b.call(context.Background(), psRequest{Tool: "list_apps"}); err != nil {
		t.Fatal(err)
	}
	if b.cmd.Process.Pid != pid {
		t.Fatal("worker restarted between ordinary requests")
	}
	if err := b.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if _, err := b.call(context.Background(), request); err == nil {
		t.Fatal("lost request replayed after worker death")
	}
	if b.cmd != nil {
		t.Fatal("failed worker was retained")
	}
	if _, err := os.Stat(directory); !os.IsNotExist(err) {
		t.Fatal("worker files not released")
	}
	if _, err := b.call(context.Background(), request); err != nil {
		t.Fatal("next explicit observation could not restart", err)
	}
}

func TestWindowsBridgeCancelledOperationDoesNotDispatch(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows bridge")
	}
	b := &windowsBridge{}
	defer b.close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := b.call(ctx, psRequest{Tool: "list_apps"}); err == nil || b.cmd != nil {
		t.Fatal("cancelled request started worker")
	}
	// Cancel while initialization is in flight; a new observation must start a
	// fresh worker rather than consume the cancelled request's late response.
	ctx, cancel = context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if _, err := b.call(ctx, psRequest{Tool: "list_apps"}); err == nil {
		t.Fatal("deadline ignored")
	}
	if b.cmd != nil {
		t.Fatal("timed out worker retained")
	}
}

// Read-only, identical window enumeration: separate initialization overhead
// from model latency and from UI action/observation costs.
func BenchmarkWindowsBridge(b *testing.B) {
	if runtime.GOOS != "windows" {
		b.Skip("Windows bridge")
	}
	request := psRequest{Tool: "list_apps"}
	b.Run("per_call_process", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if _, err := runPowerShell(request); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("reused_process", func(b *testing.B) {
		worker := &windowsBridge{}
		defer worker.close()
		if _, err := worker.call(context.Background(), request); err != nil {
			b.Fatal(err)
		}
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := worker.call(context.Background(), request); err != nil {
				b.Fatal(err)
			}
		}
		b.StopTimer()
	})
}
