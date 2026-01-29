import { ref, nextTick } from "vue";

export function useAutoScroll() {
  const container = ref<HTMLElement | null>(null);
  let shouldFollow = true;

  function onScroll() {
    if (!container.value) return;
    const { scrollTop, scrollHeight, clientHeight } = container.value;

    // 距离底部 < 80px 才自动跟随
    shouldFollow = scrollHeight - (scrollTop + clientHeight) < 80;
  }

  async function scrollToBottom() {
    if (!shouldFollow) return;
    await nextTick(); // 等 DOM 更新完成
    requestAnimationFrame(() => {
      if (container.value) {
        container.value.scrollTop = container.value.scrollHeight;
      }
    });
  }

  return { container, onScroll, scrollToBottom };
}
