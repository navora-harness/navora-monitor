package core

import (
	"io/fs"

	"github.com/navora-harness/navora-monitor/server/internal/webui"
)

func subFS() (fs.FS, error) {
	return fs.Sub(webui.Files(), "files")
}
