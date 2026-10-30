package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

type desktopLease struct {
	Version    int    `json:"version"`
	Token      string `json:"token"`
	Generation string `json:"generation"`
}

func desktopControlDirectory() string {
	if dir := os.Getenv("CODEBUDDY_DESKTOP_CONTROL_DIRECTORY"); dir != "" {
		return dir
	}
	root := os.Getenv("LOCALAPPDATA")
	if root == "" {
		root, _ = os.UserHomeDir()
	}
	return filepath.Join(root, "CodeBuddy", "desktop-control-v1")
}

// Host metadata is outside model-visible arguments. Changing lease invalidates
// all cached UIA elements, including in an existing MCP connection.
func (s *service) prepareDesktopControl(params map[string]any) error {
	meta, _ := params["_meta"].(map[string]any)
	value, _ := meta["codebuddy/desktop-control"].(map[string]any)
	token, _ := value["token"].(string)
	generation, _ := value["generation"].(string)
	if value == nil && os.Getenv("CODEBUDDY_DESKTOP_MANAGED") != "1" {
		directory := desktopControlDirectory()
		for _, name := range []string{"paused", "lease.json"} {
			if _, err := os.Stat(filepath.Join(directory, name)); !os.IsNotExist(err) {
				return errors.New("Desktop is reserved or paused by CodeBuddy; standalone input is not admitted")
			}
		}
		s.controlDirectory, s.controlIdentity = "", ""
		return nil
	}
	if token == "" || generation == "" {
		return errors.New("Desktop control requires a current host lease; update/reconnect the desktop host. No action dispatched.")
	}
	directory := desktopControlDirectory()
	if _, err := os.Stat(filepath.Join(directory, "paused")); !os.IsNotExist(err) {
		return errors.New("DESKTOP_PAUSED: User has taken control. Continue independent non-desktop work; do not retry or switch input tools.")
	}
	raw, err := os.ReadFile(filepath.Join(directory, "lease.json"))
	if err != nil {
		return errors.New("Desktop control lease is missing; no action dispatched")
	}
	var lease desktopLease
	if json.Unmarshal(raw, &lease) != nil || lease.Version != 1 || lease.Token != token || lease.Generation != generation {
		return errors.New("Desktop control lease changed; observe again after acquiring control")
	}
	if s.controlGeneration != generation {
		s.snapshots = map[string]*appSnapshot{}
	}
	s.controlDirectory, s.controlIdentity, s.controlGeneration = directory, string(raw), generation
	return nil
}
