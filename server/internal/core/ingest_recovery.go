package core

// Re-evaluate current demand, not a captured list of failed sessions: stopping
// a recording or hiding a preview during backoff must cancel its recovery.
// acquire enforces one shared retry budget for both consumers of each channel.
func (c *Core) recoverSharedMedia() {
	select {
	case <-c.shutdownCh:
		return
	default:
	}
	c.resumeRemembered()
	c.applySchedule()
	c.prev.reconcile()
}
