/** Shared modal focus handling for desktop and remote shells. */
export function installAccessibility() {
  const selector = '[role="dialog"], .drawer-layer[aria-modal="true"]'
  const focusables = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  const opened = new Map<HTMLElement, HTMLElement | null>()
  let frame = 0
  const visible = (el: HTMLElement) => el.getClientRects().length > 0 && !el.closest('[inert]')
  const modals = () => [...document.querySelectorAll<HTMLElement>(selector)].filter(visible)
  const update = () => {
    frame = 0
    const current = modals()
    for (const [el, previous] of opened) {
      if (!current.includes(el)) {
        opened.delete(el)
        if (previous?.isConnected && visible(previous)) previous.focus({ preventScroll: true })
      }
    }
    for (const el of current) {
      if (opened.has(el)) continue
      opened.set(el, document.activeElement as HTMLElement | null)
      el.setAttribute('aria-modal', 'true')
      if (!el.hasAttribute('tabindex')) el.tabIndex = -1
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
        el.setAttribute('aria-label', el.querySelector('h2, h3')?.textContent?.trim() || '操作窗口')
      }
      if (!el.contains(document.activeElement)) {
        const target = [...el.querySelectorAll<HTMLElement>(focusables)].find(visible)
        ;(target || el).focus({ preventScroll: true })
      }
    }
    document.body.classList.toggle('modal-open', current.length > 0)
    document.querySelectorAll<HTMLElement>('button[title], [role="slider"][title]').forEach(el => {
      if (!el.textContent?.trim() && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title)
    })
  }
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(update)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('focusin', event => {
    const modal = modals().at(-1)
    if (modal && !modal.contains(event.target as Node)) {
      const target = [...modal.querySelectorAll<HTMLElement>(focusables)].find(visible)
      ;(target || modal).focus({ preventScroll: true })
    }
  })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const modal = modals().at(-1)
    if (!modal) return
    const items = [...modal.querySelectorAll<HTMLElement>(focusables)].filter(visible)
    const first = items[0] || modal
    const last = items.at(-1) || modal
    if (!modal.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  })
  update()
}
