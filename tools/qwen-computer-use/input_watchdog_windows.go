//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

// The Go parent observes only tagged mouse input from its own PowerShell child.
// It survives a killed bridge, and releases only injected buttons still down.
type inputWatchdog struct {
	thread uint32
	done   chan struct{}
}
type watchdogMessage struct {
	window         uintptr
	message        uint32
	wparam, lparam uintptr
	time           uint32
	x, y           int32
	private        uint32
}
type watchdogMouse struct {
	x, y              int32
	data, flags, time uint32
	extra             uintptr
}

var watchUser32 = syscall.NewLazyDLL("user32.dll")
var watchKernel32 = syscall.NewLazyDLL("kernel32.dll")

func watchInput(pid int) (*inputWatchdog, error) {
	w := &inputWatchdog{done: make(chan struct{})}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(w.done)
		id, _, _ := watchKernel32.NewProc("GetCurrentThreadId").Call()
		w.thread = uint32(id)
		var msg watchdogMessage
		watchUser32.NewProc("PeekMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 0)
		held := uint32(0)
		callback := syscall.NewCallback(func(code int, message uintptr, data uintptr) uintptr {
			if code >= 0 {
				var value watchdogMouse
				watchKernel32.NewProc("RtlMoveMemory").Call(uintptr(unsafe.Pointer(&value)), data, unsafe.Sizeof(value))
				if uint32(value.extra) == 0x43425544 && uint32(uint64(value.extra)>>32) == uint32(pid) {
					switch message {
					case 0x201:
						held |= 4
					case 0x202:
						held &^= 4
					case 0x204:
						held |= 16
					case 0x205:
						held &^= 16
					case 0x207:
						held |= 64
					case 0x208:
						held &^= 64
					}
				}
			}
			result, _, _ := watchUser32.NewProc("CallNextHookEx").Call(0, uintptr(code), message, data)
			return result
		})
		module, _, _ := watchKernel32.NewProc("GetModuleHandleW").Call(0)
		hook, _, err := watchUser32.NewProc("SetWindowsHookExW").Call(14, callback, module, 0)
		if hook == 0 {
			ready <- fmt.Errorf("input cleanup observer unavailable: %w", err)
			return
		}
		defer watchUser32.NewProc("UnhookWindowsHookEx").Call(hook)
		ready <- nil
		for {
			result, _, _ := watchUser32.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if result == 0 || result == ^uintptr(0) || msg.message == 0x8001 {
				break
			}
			watchUser32.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&msg)))
			watchUser32.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&msg)))
		}
		if held != 0 {
			// Windows x64 INPUT: type at 0, union at 8, mouse flags at 20.
			var input [40]byte
			binary.LittleEndian.PutUint32(input[20:], held)
			binary.LittleEndian.PutUint64(input[32:], uint64(uint32(pid))<<32|0x43425544)
			watchUser32.NewProc("SendInput").Call(1, uintptr(unsafe.Pointer(&input[0])), 40)
		}
		runtime.KeepAlive(callback)
	}()
	if err := <-ready; err != nil {
		return nil, err
	}
	return w, nil
}
func (w *inputWatchdog) close() {
	watchUser32.NewProc("PostThreadMessageW").Call(uintptr(w.thread), 0x8001, 0, 0)
	<-w.done
}
