package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

type recordedTextInput struct{ bytes.Buffer }

func (*recordedTextInput) Close() error { return nil }

func TestLiteralTextSurvivesToolDispatchUntrimmed(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows framed bridge")
	}
	for _, tc := range []struct{ tool, field, value string }{
		{"type_text", "text", " \t中文🙂 \t"},
		{"type_text", "text", "   "},
		{"set_value", "value", "\n  first\nsecond  \n"},
		{"set_value", "value", ""},
	} {
		t.Run(tc.tool+tc.value, func(t *testing.T) {
			// Exercise the real tool dispatcher and serialized runtime request.
			// A framed, recording transport replaces the OS input boundary only.
			s := newService()
			s.rememberSnapshot("editor", &appSnapshot{App: appDescriptor{PID: 7}, WindowHandle: 11, Elements: []elementRecord{{Index: 0}}})
			input := &recordedTextInput{}
			s.bridge.cmd = &exec.Cmd{}
			s.bridge.in = input
			s.bridge.out = bufio.NewReader(strings.NewReader("{\"ok\":true,\"actionDispatched\":true,\"text\":\"recorded\"}\n"))
			result := s.callTool(tc.tool, map[string]any{"app": "editor", "element_index": "0", tc.field: tc.value})
			if result.IsError {
				t.Fatal(result)
			}
			var request map[string]any
			if err := json.Unmarshal(input.Bytes(), &request); err != nil {
				t.Fatal(err)
			}
			got, _ := request[tc.field].(string)
			if got != tc.value {
				t.Fatalf("literal text changed: got %q, want %q", got, tc.value)
			}
		})
	}
	for _, value := range []any{nil, 42} {
		if !newService().callTool("set_value", map[string]any{"app": "editor", "element_index": "0", "value": value}).IsError {
			t.Fatal("missing/non-text value could clear the editor")
		}
	}
}
