package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Opening documents is not a command runner. Resolve links before checking type,
// and reject network/device paths, executables, scripts and shell shortcuts.
func documentPath(input string) (string, error) {
	if !filepath.IsAbs(input) || strings.HasPrefix(input, `\\`) || strings.ContainsAny(input, "\x00\r\n") {
		return "", errors.New("Use an absolute local file or folder path; URLs, network and device paths are not supported")
	}
	if runtime.GOOS == "windows" && (len(filepath.VolumeName(input)) != 2 || strings.Contains(input[2:], ":")) {
		return "", errors.New("Use a local drive path without alternate data streams")
	}
	resolved, err := filepath.EvalSymlinks(input)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(resolved, `\\`) {
		return "", errors.New("Network and device targets are not supported")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return resolved, nil
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("Target must be a regular document or folder")
	}
	switch strings.ToLower(filepath.Ext(resolved)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".pdf", ".txt", ".md", ".csv", ".rtf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".mp3", ".wav", ".mp4", ".webm", ".mov":
		return resolved, nil
	default:
		return "", errors.New("Unsupported document type; executables, scripts and shortcuts are not opened by this tool")
	}
}

func (s *service) openPath(input string) toolCallResult {
	if runtime.GOOS != "windows" {
		return textResult("open_path is currently available on Windows only", true)
	}
	if os.Getenv("OPEN_COMPUTER_USE_WINDOWS_FOREGROUND_INPUT") != "1" {
		return textResult("Opening desktop documents requires --foreground-input opt-in", true)
	}
	target, err := documentPath(input)
	if err != nil {
		return textResult(err.Error(), true)
	}
	// The launch can change window focus even when its response is interrupted.
	s.snapshots = map[string]*appSnapshot{}
	response, err := s.runRuntime(psRequest{Tool: "open_path", Path: target})
	if err != nil {
		return textResult(err.Error(), true)
	}
	if !response.OK {
		return response.controlReceipt(textResult(response.Error, true))
	}
	result := textResult(fmt.Sprintf("Open requested for %q. The OS accepted the launch; this is not proof of visible content. Observe the target with get_app_state; do not launch again merely because verification is pending.\n%s", target, response.Text), false)
	result.StructuredContent = map[string]any{"path": target, "launch_accepted": true, "content_verified": false}
	return result
}
