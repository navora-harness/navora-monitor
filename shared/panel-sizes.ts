/** UI layout: panel sizes + visibility + mosaic wall */

export type PanelSizes = {
  explorer: number
  inspector: number
  timeline: number
}

export type UiLayoutState = {
  version: 1
  panelSizes: PanelSizes
  showExplorer: boolean
  showInspector: boolean
  showTimeline: boolean
  mosaic: 1 | 4 | 9 | 16
  /** Mosaic wall channel ids (length 16); null = empty cell */
  slotIds: (string | null)[]
}

export const PANEL_LIMITS = {
  explorer: { min: 180, max: 420, default: 240 },
  inspector: { min: 220, max: 480, default: 280 },
  timeline: { min: 100, max: 360, default: 160 },
} as const

export const MOSAIC_SLOT_COUNT = 16

export function defaultPanelSizes(): PanelSizes {
  return {
    explorer: PANEL_LIMITS.explorer.default,
    inspector: PANEL_LIMITS.inspector.default,
    timeline: PANEL_LIMITS.timeline.default,
  }
}

export function emptySlotIds(): (string | null)[] {
  return Array.from({ length: MOSAIC_SLOT_COUNT }, () => null)
}

export function sanitizeSlotIds(raw: unknown): (string | null)[] {
  const out = emptySlotIds()
  if (!Array.isArray(raw)) return out
  for (let i = 0; i < MOSAIC_SLOT_COUNT; i++) {
    const v = raw[i]
    out[i] = typeof v === 'string' && v.trim() ? v.trim() : null
  }
  return out
}

export function defaultUiLayout(): UiLayoutState {
  return {
    version: 1,
    panelSizes: defaultPanelSizes(),
    showExplorer: true,
    showInspector: false,
    showTimeline: true,
    mosaic: 4,
    slotIds: emptySlotIds(),
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function sanitizeUiLayout(raw: Partial<UiLayoutState> | null | undefined): UiLayoutState {
  const base = defaultUiLayout()
  const sizes = raw?.panelSizes ?? base.panelSizes
  const mosaicRaw = Number(raw?.mosaic)
  const mosaic = ([1, 4, 9, 16] as const).includes(mosaicRaw as 1 | 4 | 9 | 16)
    ? (mosaicRaw as 1 | 4 | 9 | 16)
    : base.mosaic
  return {
    version: 1,
    panelSizes: {
      explorer: clamp(Number(sizes.explorer) || base.panelSizes.explorer, PANEL_LIMITS.explorer.min, PANEL_LIMITS.explorer.max),
      inspector: clamp(
        Number(sizes.inspector) || base.panelSizes.inspector,
        PANEL_LIMITS.inspector.min,
        PANEL_LIMITS.inspector.max,
      ),
      timeline: clamp(Number(sizes.timeline) || base.panelSizes.timeline, PANEL_LIMITS.timeline.min, PANEL_LIMITS.timeline.max),
    },
    showExplorer: raw?.showExplorer !== false,
    showInspector: raw?.showInspector === true,
    showTimeline: raw?.showTimeline !== false,
    mosaic,
    slotIds: sanitizeSlotIds(raw?.slotIds),
  }
}
