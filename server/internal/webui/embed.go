package webui

import "embed"

//go:embed all:files
var files embed.FS

func Files() embed.FS { return files }
