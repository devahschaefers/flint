import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadCursor, ThreadListView, WireThread } from '../../../preload/index.d'
import { useAppStore } from '../store'
import { useLatest } from './useLatest'

/**
 * Data hooks for views. Mail lives in main's SQLite; a view asks for exactly
 * what it shows and asks again whenever the store's `mailVersion` ticks (the
 * `mail:changed` push). Previous results stay on screen while a refresh is in
 * flight, so lists never flash empty.
 */

interface QueryState<T> {
  data: T | undefined
  loading: boolean
  error: string | null
}

/**
 * Run `load` when `deps` change and on every mail change. Stale responses
 * (an older request resolving after a newer one) are dropped. With no account
 * connected nothing is loaded and the result reads as empty.
 */
export function useMailQuery<T>(load: () => Promise<T>, deps: readonly unknown[]): QueryState<T> {
  const mailVersion = useAppStore((s) => s.mailVersion)
  const connected = useAppStore((s) => s.connected)
  const [state, setState] = useState<QueryState<T>>({ data: undefined, loading: true, error: null })
  const seq = useRef(0)
  const loadRef = useLatest(load)

  useEffect(() => {
    if (!connected) return
    const id = ++seq.current
    let cancelled = false
    // Flag the refresh on the next tick so the effect itself doesn't set state
    const flag = window.setTimeout(() => {
      if (!cancelled) setState((s) => (s.loading ? s : { ...s, loading: true }))
    }, 0)
    loadRef
      .current()
      .then((data) => {
        if (id === seq.current) setState({ data, loading: false, error: null })
      })
      .catch((err: unknown) => {
        if (id === seq.current) {
          setState((s) => ({ ...s, loading: false, error: (err as Error).message }))
        }
      })
      .finally(() => {
        cancelled = true
        window.clearTimeout(flag)
      })
    return () => {
      cancelled = true
      window.clearTimeout(flag)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's key
  }, [connected, mailVersion, ...deps])

  if (!connected) return { data: undefined, loading: false, error: null }
  return state
}

export const THREAD_PAGE = 50

export interface ThreadPages {
  threads: WireThread[]
  loading: boolean
  hasMore: boolean
  /** Fetch the next page (no-op while loading or when exhausted) */
  loadMore: () => void
}

interface PagesState {
  threads: WireThread[]
  cursor: ThreadCursor | null
  hasMore: boolean
  loading: boolean
}

/**
 * Infinite-scroll pages of one thread list. A mail change re-fetches every
 * page currently loaded (in page-sized steps, so the cursor chain stays
 * valid) and replaces the list in one update.
 */
export function useThreadPages(accountId: string | null, view: ThreadListView): ThreadPages {
  const mailVersion = useAppStore((s) => s.mailVersion)
  const connected = useAppStore((s) => s.connected)
  const [state, setState] = useState<PagesState>({
    threads: [],
    cursor: null,
    hasMore: true,
    loading: true
  })
  const seq = useRef(0)
  const loadedRef = useRef(0)
  const viewRef = useLatest(view)
  const viewKey = JSON.stringify(view)

  // (Re)load from the top: as many pages as were loaded before, at least one
  useEffect(() => {
    if (!connected) return
    const id = ++seq.current
    const wanted = Math.max(1, Math.ceil(loadedRef.current / THREAD_PAGE))
    void (async () => {
      const all: WireThread[] = []
      let next: ThreadCursor | null = null
      let more = true
      for (let page = 0; page < wanted && more; page++) {
        const res = await window.api.listThreads({
          accountId,
          view: viewRef.current,
          cursor: next,
          limit: THREAD_PAGE
        })
        if (id !== seq.current) return
        all.push(...res.threads)
        next = res.nextCursor
        more = next !== null
      }
      loadedRef.current = all.length
      setState({ threads: all, cursor: next, hasMore: more, loading: false })
    })().catch((err: unknown) => {
      if (id === seq.current) {
        console.error('thread list failed:', err)
        setState((s) => ({ ...s, loading: false }))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewKey stands in for view
  }, [connected, mailVersion, accountId, viewKey])

  const loadMore = useCallback(() => {
    setState((s) => {
      if (s.loading || !s.hasMore || !s.cursor) return s
      const id = seq.current
      window.api
        .listThreads({ accountId, view: viewRef.current, cursor: s.cursor, limit: THREAD_PAGE })
        .then((res) => {
          if (id !== seq.current) return
          setState((cur) => {
            const threads = [...cur.threads, ...res.threads]
            loadedRef.current = threads.length
            return {
              threads,
              cursor: res.nextCursor,
              hasMore: res.nextCursor !== null,
              loading: false
            }
          })
        })
        .catch((err: unknown) => {
          console.error('thread page failed:', err)
          if (id === seq.current) setState((cur) => ({ ...cur, loading: false }))
        })
      return { ...s, loading: true }
    })
  }, [accountId, viewRef])

  if (!connected) return { threads: [], loading: false, hasMore: false, loadMore }
  return { threads: state.threads, loading: state.loading, hasMore: state.hasMore, loadMore }
}

/**
 * Calls `onReach` when the sentinel element scrolls into view. Attach the
 * returned ref to an empty element at the bottom of a list.
 */
export function useReachBottom(
  onReach: () => void,
  enabled: boolean
): (el: HTMLElement | null) => void {
  const cb = useLatest(onReach)
  const observer = useRef<IntersectionObserver | null>(null)
  return useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect()
      observer.current = null
      if (!el || !enabled) return
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) cb.current()
        },
        { rootMargin: '400px' }
      )
      observer.current.observe(el)
    },
    [enabled, cb]
  )
}
