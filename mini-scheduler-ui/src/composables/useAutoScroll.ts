import { nextTick, ref, type Ref } from "vue";

const FOLLOW_THRESHOLD_PX = 80;

/**
 * Keeps a scrollable log view pinned to the bottom, but stops following as soon
 * as the reader scrolls up — and resumes when they scroll back down.
 */
export function useAutoScroll(container: Ref<HTMLElement | null>) {
  const following = ref(true);

  function onScroll() {
    const element = container.value;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - (element.scrollTop + element.clientHeight);
    following.value = distanceFromBottom < FOLLOW_THRESHOLD_PX;
  }

  async function scrollToBottom({ force = false } = {}) {
    if (!following.value && !force) return;
    await nextTick();
    requestAnimationFrame(() => {
      const element = container.value;
      if (!element) return;
      element.scrollTop = element.scrollHeight;
      following.value = true;
    });
  }

  return { following, onScroll, scrollToBottom };
}
