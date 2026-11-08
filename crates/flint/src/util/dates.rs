//! Date labels for lists, ported from `src/renderer/src/lib/dates.ts`.
//! All arithmetic is in local calendar days, Monday-based weeks.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Timelike};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum DateBucket {
    Today,
    Yesterday,
    ThisWeek,
    LastWeek,
    Older,
}

impl DateBucket {
    pub fn label(self) -> &'static str {
        match self {
            DateBucket::Today => "Today",
            DateBucket::Yesterday => "Yesterday",
            DateBucket::ThisWeek => "This Week",
            DateBucket::LastWeek => "Last Week",
            DateBucket::Older => "Older",
        }
    }
}

pub fn local(ms: i64) -> DateTime<Local> {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(|| Local.timestamp_millis_opt(0).unwrap())
}

fn day(d: &DateTime<Local>) -> NaiveDate {
    d.date_naive()
}

/// Days since the Monday of `d`'s week
fn weekday_offset(d: NaiveDate) -> i64 {
    d.weekday().num_days_from_monday() as i64
}

pub fn date_bucket_at(ms: i64, now: DateTime<Local>) -> DateBucket {
    let t = day(&local(ms));
    let today = day(&now);
    if t >= today {
        return DateBucket::Today;
    }
    if t >= today - Duration::days(1) {
        return DateBucket::Yesterday;
    }
    let week_start = today - Duration::days(weekday_offset(today));
    if t >= week_start {
        return DateBucket::ThisWeek;
    }
    if t >= week_start - Duration::days(7) {
        return DateBucket::LastWeek;
    }
    DateBucket::Older
}

/// Group items (already newest first) into ordered buckets
pub fn group_by_bucket<T>(items: &[T], date_ms: impl Fn(&T) -> i64) -> Vec<(DateBucket, Vec<&T>)> {
    let now = Local::now();
    let mut out: Vec<(DateBucket, Vec<&T>)> = Vec::new();
    for item in items {
        let b = date_bucket_at(date_ms(item), now);
        match out.iter_mut().find(|(bucket, _)| *bucket == b) {
            Some((_, list)) => list.push(item),
            None => out.push((b, vec![item])),
        }
    }
    out.sort_by_key(|(b, _)| *b);
    out
}

const MONTHS: [&str; 12] =
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// "2:32 PM" today, "Mon" within six days, "Sep 2" this year, else "Sep 2, 2025"
pub fn short_date_at(ms: i64, now: DateTime<Local>) -> String {
    let t = local(ms);
    let (tday, today) = (day(&t), day(&now));
    if tday == today {
        let h = t.hour();
        let h12 = if h % 12 == 0 { 12 } else { h % 12 };
        return format!("{h12}:{:02} {}", t.minute(), if h < 12 { "AM" } else { "PM" });
    }
    if tday >= today - Duration::days(6) {
        return WEEKDAYS[t.weekday().num_days_from_sunday() as usize].to_string();
    }
    let month = MONTHS[t.month0() as usize];
    if t.year() == now.year() {
        format!("{month} {}", t.day())
    } else {
        format!("{month} {}, {}", t.day(), t.year())
    }
}

pub fn short_date(ms: i64) -> String {
    short_date_at(ms, Local::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, min, 0).single().unwrap()
    }

    #[test]
    fn buckets() {
        // Wednesday 2026-11-04
        let now = at(2026, 11, 4, 12, 0);
        let b = |y, m, d| date_bucket_at(at(y, m, d, 9, 0).timestamp_millis(), now);
        assert_eq!(b(2026, 11, 4), DateBucket::Today);
        assert_eq!(b(2026, 11, 3), DateBucket::Yesterday);
        assert_eq!(b(2026, 11, 2), DateBucket::ThisWeek);
        assert_eq!(b(2026, 11, 1), DateBucket::LastWeek);
        assert_eq!(b(2026, 10, 26), DateBucket::LastWeek);
        assert_eq!(b(2026, 10, 25), DateBucket::Older);
    }

    #[test]
    fn short_dates() {
        let now = at(2026, 11, 4, 18, 0);
        assert_eq!(short_date_at(at(2026, 11, 4, 14, 32).timestamp_millis(), now), "2:32 PM");
        assert_eq!(short_date_at(at(2026, 11, 4, 0, 5).timestamp_millis(), now), "12:05 AM");
        assert_eq!(short_date_at(at(2026, 11, 2, 9, 0).timestamp_millis(), now), "Mon");
        assert_eq!(short_date_at(at(2026, 9, 2, 9, 0).timestamp_millis(), now), "Sep 2");
        assert_eq!(short_date_at(at(2025, 9, 2, 9, 0).timestamp_millis(), now), "Sep 2, 2025");
    }
}
