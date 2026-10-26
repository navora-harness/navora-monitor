package core

import (
	"fmt"
	"strings"
)

// Caller holds rec.opMu; metadata-only edits must not interrupt media.
func (c *Core) reconcileChannelChangesLocked(previous, next []Channel) error {
	byID := make(map[string]Channel, len(next))
	for _, ch := range next {
		byID[ch.ID] = ch
	}
	var failures []string
	for _, old := range previous {
		ch, exists := byID[old.ID]
		previewChanged := !exists || ch.Enabled != old.Enabled || ch.URL != old.URL || ch.PreviewURL != old.PreviewURL || ch.RtspTransport != old.RtspTransport
		recordChanged := !exists || ch.Enabled != old.Enabled || ch.URL != old.URL || ch.RtspTransport != old.RtspTransport || ch.SegmentTimeSec != old.SegmentTimeSec
		if recordChanged {
			c.rec.mu.Lock()
			session := c.rec.sess[old.ID]
			reason := ""
			if session != nil {
				reason = session.reason
			}
			c.rec.mu.Unlock()
			c.rec.stopLocked(old.ID)
			if exists && ch.Enabled && session != nil {
				if err := c.rec.startLocked(ch, reason); err != nil {
					failures = append(failures, ch.Name+": "+redactSecrets(err.Error()))
				}
			}
		}
		if previewChanged {
			c.prev.mu.Lock()
			active := c.prev.sess[old.ID] != nil
			c.prev.mu.Unlock()
			c.prev.stop(old.ID)
			if !exists || !ch.Enabled {
				c.ClearPreviewWant(old.ID)
			} else if active || c.wantedPreviews()[old.ID] {
				if err := c.prev.start(old.ID); err != nil {
					failures = append(failures, ch.Name+": "+redactSecrets(err.Error()))
				}
			}
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("通道已保存，但部分采集恢复失败：%s", strings.Join(failures, "; "))
	}
	return nil
}
