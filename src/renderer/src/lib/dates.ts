export type DateBucket = 'Today' | 'Yesterday' | 'This Week' | 'Last Week' | 'Older'

const DAY = 24 * 60 * 60 * 1000

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Monday-based start of the week containing `d`. */
function startOfWeek(d: Date): number {
  const dow = (d.getDay() + 6) % 7
  return startOfDay(d) - dow * DAY
}

export function dateBucket(iso: string, now: Date = new Date()): DateBucket {
  const t = new Date(iso)
  const today = startOfDay(now)
  const day = startOfDay(t)
  if (day >= today) return 'Today'
  if (day >= today - DAY) return 'Yesterday'
  const week = startOfWeek(now)
  if (day >= week) return 'This Week'
  if (day >= week - 7 * DAY) return 'Last Week'
  return 'Older'
}

const BUCKET_ORDER: DateBucket[] = ['Today', 'Yesterday', 'This Week', 'Last Week', 'Older']

/** Group emails (already sorted newest-first) into ordered date buckets. */
export function groupByBucket<T>(items: T[], getDate: (item: T) => string): [DateBucket, T[]][] {
  const groups = new Map<DateBucket, T[]>()
  for (const item of items) {
    const bucket = dateBucket(getDate(item))
    const list = groups.get(bucket) ?? []
    list.push(item)
    groups.set(bucket, list)
  }
  return BUCKET_ORDER.filter((b) => groups.has(b)).map((b) => [b, groups.get(b)!])
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "12:45" for today, otherwise "Aug 26" like Spark's list rows. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const t = new Date(iso)
  if (startOfDay(t) === startOfDay(now)) {
    const h = t.getHours()
    const m = t.getMinutes().toString().padStart(2, '0')
    return `${h}:${m}`
  }
  return `${MONTHS[t.getMonth()]} ${t.getDate()}`
}
