package core

import (
	"fmt"
	"log"
	"strings"
)

// Hold the recorder operation lock across stop, save and resume, including
// background resume/schedule attempts. Preserve each session's original reason.
func (c *Core) UpdateSettingsAndResume(next Settings) (Settings, error) {
	c.rec.opMu.Lock()
	defer c.rec.opMu.Unlock()
	return c.updateSettingsAndResumeLocked(next)
}

func (c *Core) updateSettingsAndResumeLocked(next Settings) (Settings, error) {
	previous := c.Settings()
	normalized := c.storageDefaults(sanitizeSettings(next), false)
	changed := !samePath(normalized.RecordingsPath, previous.RecordingsPath) ||
		!samePath(normalized.RecordCachePath, previous.RecordCachePath) || normalized.RecordCacheEnabled != previous.RecordCacheEnabled
	if !changed {
		return c.updateSettingsLocked(next)
	}
	reasons := map[string]string{}
	channels := c.Channels()
	for _, ch := range channels {
		if c.rec.running(ch.ID) {
			c.rec.mu.Lock()
			reasons[ch.ID] = c.rec.sess[ch.ID].reason
			c.rec.mu.Unlock()
		}
	}
	log.Printf("settings storage switch stopping=%d cacheEnabled=%t", len(reasons), normalized.RecordCacheEnabled)
	for _, ch := range channels {
		if _, ok := reasons[ch.ID]; ok {
			c.rec.stopLocked(ch.ID)
		}
	}
	saved, saveErr := c.updateSettingsLocked(next)
	if saveErr != nil {
		log.Printf("settings storage switch failed error=%q; resuming recordings with current settings", redactSecrets(saveErr.Error()))
	}
	var failures []string
	for _, ch := range channels {
		if reason, ok := reasons[ch.ID]; ok {
			if err := c.rec.startLocked(ch, reason); err != nil {
				failures = append(failures, fmt.Sprintf("%s: %s", ch.Name, redactSecrets(err.Error())))
			}
		}
	}
	if len(failures) > 0 {
		detail := strings.Join(failures, "; ")
		log.Printf("settings recording resume failed detail=%q", detail)
		if saveErr != nil {
			return Settings{}, fmt.Errorf("设置保存失败：%v；部分录像恢复失败：%s", saveErr, detail)
		}
		return saved, fmt.Errorf("设置已保存，但部分录像恢复失败：%s", detail)
	}
	if saveErr != nil {
		return Settings{}, fmt.Errorf("设置保存失败，已重新启动原录制通道：%w", saveErr)
	}
	log.Printf("settings storage switch complete resumed=%d", len(reasons))
	return saved, nil
}
