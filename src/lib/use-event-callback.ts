'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';

/** Stable UI handlers that always use the latest committed state. */
export function useEventCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useCallback((...args: Args): Result => callbackRef.current(...args), []);
}
