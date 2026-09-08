import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * A ref that always holds the latest render's `value`, for callbacks created once
 * (TipTap keymaps, window listeners) that must still call the newest closure.
 * Assigned in a layout effect rather than during render, so it is current before
 * any event that follows the commit. Read it from handlers and effects, never
 * during render.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}
