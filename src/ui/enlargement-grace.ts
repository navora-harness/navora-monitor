import { computed, onUnmounted, ref, watch, type Ref } from 'vue'

export const ENLARGEMENT_GRACE_MS = 60_000

export function useEnlargementGrace(index: Ref<number | null>) {
  const expired = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  watch(index, (value) => {
    if (timer) clearTimeout(timer)
    timer = null
    expired.value = false
    if (value != null) timer = setTimeout(() => {
      timer = null
      expired.value = true
    }, ENLARGEMENT_GRACE_MS)
  }, { flush: 'sync' })
  onUnmounted(() => { if (timer) clearTimeout(timer) })
  return computed(() => expired.value ? index.value : null)
}
