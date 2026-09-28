export type PickRequest = {
  mode: 'dir' | 'ffmpeg' | 'json' | 'save'
  title: string
  start?: string
  saveName?: string
}

export type PickResult = { canceled: true } | { path: string } | { file: File }

type PickFn = (req: PickRequest) => Promise<PickResult>
type RevealFn = (path: string) => Promise<void>

let pickFn: PickFn | null = null
let revealFn: RevealFn | null = null

export function registerDialogs(pick: PickFn, reveal: RevealFn) {
  pickFn = pick
  revealFn = reveal
}

export function requestPick(req: PickRequest): Promise<PickResult> {
  if (!pickFn) return Promise.resolve({ canceled: true })
  return pickFn(req)
}

export function requestReveal(path: string): Promise<void> {
  if (!revealFn) return Promise.resolve()
  return revealFn(path)
}
