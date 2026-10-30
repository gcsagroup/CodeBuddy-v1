package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDocumentPathBoundaries(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"10.26 简历 [draft].JPG", "notes.txt", "program.exe", "script.ps1", "shortcut.lnk"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{root, filepath.Join(root, "10.26 简历 [draft].JPG"), filepath.Join(root, "notes.txt")} {
		if _, err := documentPath(path); err != nil {
			t.Fatalf("valid document %q: %v", path, err)
		}
	}
	for _, path := range []string{"", "relative.jpg", "https://example.com/a.jpg", `\\server\share\a.jpg`, `\\?\C:\a.jpg`, filepath.Join(root, "missing.jpg"), filepath.Join(root, "program.exe"), filepath.Join(root, "script.ps1"), filepath.Join(root, "shortcut.lnk"), filepath.Join(root, "notes.txt") + ":payload.jpg"} {
		if _, err := documentPath(path); err == nil {
			t.Fatalf("accepted unsupported target %q", path)
		}
	}
	if runtime.GOOS != "windows" {
		link := filepath.Join(root, "disguised.jpg")
		if err := os.Symlink(filepath.Join(root, "program.exe"), link); err != nil {
			t.Fatal(err)
		}
		if _, err := documentPath(link); err == nil {
			t.Fatal("followed a disguised executable")
		}
	}
}

func TestOpenPathRequiresOptInAndIsNotReadOnly(t *testing.T) {
	t.Setenv("OPEN_COMPUTER_USE_WINDOWS_FOREGROUND_INPUT", "0")
	svc := newService()
	defer svc.close()
	if result := svc.openPath(t.TempDir()); !result.IsError {
		t.Fatal("opened a window without input opt-in")
	}
	if svc.bridge.cmd != nil {
		t.Fatal("started bridge on rejected launch")
	}
	for _, tool := range toolDefinitions() {
		if tool.Name == "open_path" && tool.Annotations["readOnlyHint"] == true {
			t.Fatal("launch advertised as read-only")
		}
	}
}
