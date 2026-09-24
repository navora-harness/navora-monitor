import {
  defaultUiLayout,
  sanitizeUiLayout,
  type UiLayoutState,
} from '@shared/panel-sizes'
import { DEFAULT_GROUP } from '@shared/groups'
import type { UiTheme } from '../theme'

const KEY = 'navora-remote-layout-v1'

export type RemoteClientLayout = UiLayoutState & {
  activeGroup: string
  uiTheme: UiTheme
  selectedId: string | null
}

export function defaultRemoteLayout(): RemoteClientLayout {
  return {
    ...defaultUiLayout(),
    showTimeline: false,
    activeGroup: DEFAULT_GROUP,
    uiTheme: 'system',
    selectedId: null,
  }
}

export function loadRemoteLayout(): RemoteClientLayout {
  const base = defaultRemoteLayout()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<RemoteClientLayout>
    const layout = sanitizeUiLayout(parsed)
    const uiTheme =
      parsed.uiTheme === 'light' || parsed.uiTheme === 'dark' || parsed.uiTheme === 'system'
        ? parsed.uiTheme
        : base.uiTheme
    return {
      ...layout,
      showTimeline: layout.showTimeline === true,
      activeGroup:
        typeof parsed.activeGroup === 'string' && parsed.activeGroup.trim()
          ? parsed.activeGroup.trim()
          : base.activeGroup,
      uiTheme,
      selectedId:
        typeof parsed.selectedId === 'string' && parsed.selectedId.trim()
          ? parsed.selectedId.trim()
          : null,
    }
  } catch {
    return base
  }
}

export function saveRemoteLayout(state: RemoteClientLayout): void {
  try {
    const clean: RemoteClientLayout = {
      ...sanitizeUiLayout(state),
      showTimeline: !!state.showTimeline,
      activeGroup: state.activeGroup || DEFAULT_GROUP,
      uiTheme:
        state.uiTheme === 'light' || state.uiTheme === 'dark' || state.uiTheme === 'system'
          ? state.uiTheme
          : 'system',
      selectedId:
        typeof state.selectedId === 'string' && state.selectedId.trim()
          ? state.selectedId.trim()
          : null,
    }
    localStorage.setItem(KEY, JSON.stringify(clean))
  } catch {
    /* quota / private mode */
  }
}
