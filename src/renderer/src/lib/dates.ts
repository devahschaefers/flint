export type DateBucket = 'Today' | 'Yesterday' | 'This Week' | 'Last Week' | 'Older'

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Midnight `n` calendar days before `d` — the Date ctor absorbs DST offset shifts. */
function daysBefore(d: Date, n: number): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime()
}

/** Monday-based start of the week containing `d`. */
function startOfWeek(d: Date): number {
  return daysBefore(d, (d.getDay() + 6) % 7)
}

export function dateBucket(iso: string, now: Date = new Date()): DateBucket {
  const t = new Date(iso)
  const today = startOfDay(now)
  const day = startOfDay(t)
  if (day >= today) return 'Today'
  if (day >= daysBefore(now, 1)) return 'Yesterday'
  if (day >= startOfWeek(now)) return 'This Week'
  if (day >= daysBefore(now, ((now.getDay() + 6) % 7) + 7)) return 'Last Week'
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
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "2:32 PM" today, then "Mon" for the last six days, then "Sep 2", then "Sep 2, 2025". */
export function shortDate(iso: string, now: Date = new Date()): string {
  const t = new Date(iso)
  if (startOfDay(t) === startOfDay(now)) {
    const h = t.getHours()
    const m = t.getMinutes().toString().padStart(2, '0')
    return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`
  }
  if (startOfDay(t) >= daysBefore(now, 6)) return WEEKDAYS[t.getDay()]
  if (t.getFullYear() === now.getFullYear()) return `${MONTHS[t.getMonth()]} ${t.getDate()}`
  return `${MONTHS[t.getMonth()]} ${t.getDate()}, ${t.getFullYear()}`
}
