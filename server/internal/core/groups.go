package core

func (c *Core) GroupOrder() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.listGroupsLocked()
}

func (c *Core) listGroupsLocked() []string {
	present := map[string]bool{defaultGroup: true}
	for _, ch := range c.channels {
		present[channelGroup(ch.Group)] = true
	}
	var result []string
	seen := map[string]bool{}
	push := func(raw string) {
		n := normalizeGroupName(raw)
		if n == "" || seen[n] {
			return
		}
		seen[n] = true
		result = append(result, n)
	}
	for _, name := range c.groupOrder {
		push(name)
	}
	// Present groups not in saved order, default group last.
	var extras []string
	for n := range present {
		if !seen[n] {
			extras = append(extras, n)
		}
	}
	sortGroups(extras)
	for _, n := range extras {
		push(n)
	}
	if result == nil {
		result = []string{defaultGroup}
	}
	return result
}

func sortGroups(names []string) {
	for i := 1; i < len(names); i++ {
		j := i
		for j > 0 && groupLess(names[j], names[j-1]) {
			names[j], names[j-1] = names[j-1], names[j]
			j--
		}
	}
}

func groupLess(a, b string) bool {
	if a == defaultGroup {
		return false
	}
	if b == defaultGroup {
		return true
	}
	return a < b
}

func (c *Core) MoveGroupBefore(groupName string, before *string) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	current := c.listGroupsLocked()
	moving := normalizeGroupName(groupName)
	if !contains(current, moving) {
		return current, nil
	}
	var beforeName string
	if before != nil {
		beforeName = normalizeGroupName(*before)
	}
	next := moveNameBefore(current, moving, beforeName)
	c.groupOrder = next
	if err := c.saveChannelsLocked(); err != nil {
		return nil, err
	}
	return append([]string(nil), next...), nil
}

func moveNameBefore(order []string, moving, before string) []string {
	var without []string
	for _, n := range order {
		if n != moving {
			without = append(without, n)
		}
	}
	if before == "" || before == moving {
		return append(without, moving)
	}
	idx := -1
	for i, n := range without {
		if n == before {
			idx = i
			break
		}
	}
	if idx < 0 {
		return append(without, moving)
	}
	out := append([]string{}, without[:idx]...)
	out = append(out, moving)
	out = append(out, without[idx:]...)
	return out
}

func (c *Core) MoveChannelsBefore(ids []string, targetGroup string, beforeID *string) ([]Channel, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	before := ""
	if beforeID != nil {
		before = *beforeID
	}
	c.channels = reorderChannelsBefore(c.channels, ids, targetGroup, before)
	tg := normalizeGroupName(targetGroup)
	if tg != defaultGroup && !contains(c.groupOrder, tg) {
		c.groupOrder = append(c.groupOrder, tg)
	}
	if err := c.saveChannelsLocked(); err != nil {
		return nil, err
	}
	return append([]Channel(nil), c.channels...), nil
}

func reorderChannelsBefore(channels []Channel, ids []string, targetGroup, beforeID string) []Channel {
	idSet := map[string]bool{}
	for _, id := range ids {
		idSet[id] = true
	}
	if len(idSet) == 0 {
		return channels
	}
	var moving []Channel
	for _, ch := range channels {
		if idSet[ch.ID] {
			moving = append(moving, ch)
		}
	}
	if len(moving) == 0 {
		return channels
	}
	group := storedGroupValue(targetGroup)
	for i := range moving {
		moving[i].Group = group
	}
	var remaining []Channel
	for _, ch := range channels {
		if !idSet[ch.ID] {
			remaining = append(remaining, ch)
		}
	}
	anchor := beforeID
	if anchor != "" && idSet[anchor] {
		start := -1
		for i, ch := range channels {
			if ch.ID == anchor {
				start = i
				break
			}
		}
		anchor = ""
		if start >= 0 {
			for i := start + 1; i < len(channels); i++ {
				if !idSet[channels[i].ID] {
					anchor = channels[i].ID
					break
				}
			}
		}
	}
	insertAt := len(remaining)
	if anchor != "" {
		for i, ch := range remaining {
			if ch.ID == anchor {
				insertAt = i
				break
			}
		}
	} else if beforeID == "" || idSet[beforeID] {
		targetName := group
		if targetName == "" {
			targetName = defaultGroup
		}
		last := -1
		for i, ch := range remaining {
			if channelGroup(ch.Group) == targetName {
				last = i
			}
		}
		if last >= 0 {
			insertAt = last + 1
		}
	}
	out := append([]Channel{}, remaining[:insertAt]...)
	out = append(out, moving...)
	out = append(out, remaining[insertAt:]...)
	return out
}

func (c *Core) CreateGroup(name string) ([]string, error) {
	n := normalizeGroupName(name)
	if stringsTrim(name) == "" {
		return nil, errStr("分组名称不能为空")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if n == defaultGroup {
		return c.listGroupsLocked(), nil
	}
	order := c.listGroupsLocked()
	if contains(order, n) {
		return nil, errStr("分组「" + n + "」已存在")
	}
	c.groupOrder = append(order, n)
	if err := c.saveChannelsLocked(); err != nil {
		return nil, err
	}
	return c.listGroupsLocked(), nil
}

func (c *Core) DeleteGroup(name string) ([]string, error) {
	src := normalizeGroupName(name)
	if src == defaultGroup {
		return nil, errStr("不能删除默认分组")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, ch := range c.channels {
		if channelGroup(ch.Group) == src {
			count++
		}
	}
	if count > 0 {
		return nil, errStr("分组「" + src + "」仍有通道，请先解散或移走")
	}
	var next []string
	for _, n := range c.groupOrder {
		if normalizeGroupName(n) != src {
			next = append(next, n)
		}
	}
	c.groupOrder = next
	if err := c.saveChannelsLocked(); err != nil {
		return nil, err
	}
	return c.listGroupsLocked(), nil
}

func (c *Core) RenameGroup(from, to string) ([]Channel, error) {
	src := normalizeGroupName(from)
	if stringsTrim(to) == "" {
		return nil, errStr("分组名称不能为空")
	}
	if src == defaultGroup {
		return nil, errStr("不能重命名默认分组")
	}
	dest := normalizeGroupName(to)
	if dest == defaultGroup {
		return nil, errStr("不能重命名为默认分组，请使用解散分组")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if dest == src {
		return append([]Channel(nil), c.channels...), nil
	}
	existing := c.listGroupsLocked()
	if contains(existing, dest) {
		return nil, errStr("分组「" + dest + "」已存在")
	}
	stored := storedGroupValue(dest)
	for i := range c.channels {
		if channelGroup(c.channels[i].Group) == src {
			c.channels[i].Group = stored
		}
	}
	for i, n := range c.groupOrder {
		if normalizeGroupName(n) == src {
			c.groupOrder[i] = dest
		}
	}
	if err := c.saveChannelsLocked(); err != nil {
		return nil, err
	}
	return append([]Channel(nil), c.channels...), nil
}

func (c *Core) DissolveGroup(name string) ([]Channel, error) {
	src := normalizeGroupName(name)
	if src == defaultGroup {
		return nil, errStr("不能解散默认分组")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.channels {
		if channelGroup(c.channels[i].Group) == src {
			c.channels[i].Group = ""
		}
	}
	var next []string
	for _, n := range c.groupOrder {
		if normalizeGroupName(n) != src {
			next = append(next, n)
		}
	}
	c.groupOrder = next
	if err := c.saveChannelsLocked(); err != nil {
		return nil, err
	}
	return append([]Channel(nil), c.channels...), nil
}

func stringsTrim(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t' || s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

type strErr string

func (e strErr) Error() string { return string(e) }

func errStr(s string) error { return strErr(s) }
