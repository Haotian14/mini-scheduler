import { ref, nextTick } from "vue";

export function useAutoScroll() {
  const container = ref<HTMLElement | null>(null);
  let shouldFollow = true;

  function onScroll() {
    if (!container.value) return;
    const { scrollTop, scrollHeight, clientHeight } = container.value;
    shouldFollow = scrollHeight - (scrollTop + clientHeight) < 80;
  }

  async function scrollToBottom() {
    if (!shouldFollow) return;
    await nextTick();
    requestAnimationFrame(() => {
      if (container.value) {
        container.value.scrollTop = container.value.scrollHeight;
      }
    });
  }

  return { container, onScroll, scrollToBottom };
}
