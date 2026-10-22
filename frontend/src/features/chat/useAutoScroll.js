import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Within this many px of the bottom counts as "following" the conversation
const BOTTOM_THRESHOLD = 48;

/**
 * Keeps a scroll container pinned to the bottom while `contentKey` changes,
 * until the user scrolls up. Scrolling back to the bottom (or scrollToBottom)
 * resumes following.
 *
 *   ref        attach to the scroll container
 *   onScroll   attach to the container's onScroll
 *   pinned     false while the user is reading further up
 */
export default function useAutoScroll(contentKey) {
  const ref = useRef(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinnedState] = useState(true);

  const setPinned = useCallback((value) => {
    pinnedRef.current = value;
    setPinnedState(value);
  }, []);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    if (atBottom !== pinnedRef.current) setPinned(atBottom);
  }, [setPinned]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
    setPinned(true);
  }, [setPinned]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [contentKey]);

  return { ref, onScroll, pinned, scrollToBottom };
}
