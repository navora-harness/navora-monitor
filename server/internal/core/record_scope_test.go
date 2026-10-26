package core

import (
	"path/filepath"
	"testing"
)

func TestRecordingProcessesAreScopedToExactStorageRoots(t *testing.T) {
	root := t.TempDir()
	archive, cache := filepath.Join(root, "录像 archives"), filepath.Join(root, "cache")
	pattern := func(base string) string { return filepath.Join(base, "cam-shared", "camera-"+segmentStrftimeSuffix) }
	processes := []recordingProcess{
		{PID: 1, Output: pattern(archive)},
		{PID: 2, Output: pattern(cache)},
		{PID: 3, Output: pattern(filepath.Join(root, "another-instance", "recordings"))},
		{PID: 4, Output: pattern(archive + "-other")},
		{PID: 5, Output: pattern(filepath.Join(archive, "nested"))},
	}
	found := recordingsForRoots(processes, []string{archive, cache, ""})
	if got := found["cam-shared"]; len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("unrelated recorder included: %v", found)
	}
}

func TestExternalRecordingRequiresSegmentWriterArguments(t *testing.T) {
	output := filepath.Join(t.TempDir(), "cam-test", "camera-"+segmentStrftimeSuffix)
	args := buildSegmentRecordArgs("rtsp://test/stream", output, "test", "tcp", 300)
	if got := recordingOutput(append([]string{"ffmpeg.exe"}, args...)); got != output {
		t.Fatalf("recording not recognized: %q", got)
	}
	for _, other := range [][]string{
		{"ffmpeg.exe", "-i", "recordings/cam-test/input.ts", "-c", "copy", output},
		{"ffmpeg.exe", "-f", "segment", "-segment_format", "mpegts", "-strftime", "0", output},
		{"ffmpeg.exe", "-f", "segment", "-segment_format", "mpegts", "-strftime", "1", "https://example.test/output.ts"},
	} {
		if got := recordingOutput(other); got != "" {
			t.Fatalf("claimed unrelated process: %q", got)
		}
	}
}
