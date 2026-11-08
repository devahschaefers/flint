//! Turn what a person typed into a search box into an FTS5 MATCH expression
//! that cannot fail to parse (port of `src/main/storage/search.ts`). Every
//! term is emitted as a quoted FTS5 string, so operators and syntax are
//! looked up as words. A trailing `*` makes a term a prefix query, and a run
//! inside double quotes is one phrase. Terms are ANDed.

use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchTerm {
    /// Words of the term (one for a bare word, several for a quoted phrase)
    pub words: Vec<String>,
    pub prefix: bool,
}

const QUOTE: char = '"';

static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}\p{M}]+").unwrap());

/// Split on anything unicode61 would split on (punctuation, symbols, whitespace)
fn tokenize_words(s: &str) -> Vec<String> {
    SPLIT.split(s).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

fn is_space(c: char) -> bool {
    // JS /\s/: Unicode whitespace plus the BOM
    c.is_whitespace() || c == '\u{feff}'
}

pub fn parse_search_terms(raw: &str) -> Vec<SearchTerm> {
    let chars: Vec<char> = raw.chars().collect();
    let n = chars.len();
    let mut terms = Vec::new();
    let mut i = 0;
    while i < n {
        let ch = chars[i];
        if is_space(ch) {
            i += 1;
            continue;
        }
        if ch == QUOTE {
            // Phrase: up to the closing quote (or end of input)
            let end = chars[i + 1..].iter().position(|&c| c == QUOTE).map(|p| p + i + 1);
            let inner: String = match end {
                Some(e) => chars[i + 1..e].iter().collect(),
                None => chars[i + 1..].iter().collect(),
            };
            i = match end {
                Some(e) => e + 1,
                None => n,
            };
            let mut prefix = false;
            if i < n && chars[i] == '*' {
                prefix = true;
                i += 1;
            }
            let words = tokenize_words(&inner);
            if !words.is_empty() {
                terms.push(SearchTerm { words, prefix });
            }
            continue;
        }
        // Bare word: runs to the next whitespace or quote
        let mut j = i;
        while j < n && !is_space(chars[j]) && chars[j] != QUOTE {
            j += 1;
        }
        let mut word: String = chars[i..j].iter().collect();
        i = j;
        let prefix = word.ends_with('*');
        if prefix {
            word = word.trim_end_matches('*').to_string();
        }
        let words = tokenize_words(&word);
        if !words.is_empty() {
            terms.push(SearchTerm { words, prefix });
        }
    }
    terms
}

/// The MATCH expression, or None when the input holds no searchable word
/// (the caller then returns no results rather than matching everything)
pub fn build_match_expression(raw: &str) -> Option<String> {
    let terms = parse_search_terms(raw);
    if terms.is_empty() {
        return None;
    }
    Some(
        terms
            .iter()
            .map(|t| {
                let phrase = format!("\"{}\"", t.words.join(" "));
                if t.prefix {
                    format!("{phrase} *")
                } else {
                    phrase
                }
            })
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(s: &str) -> Option<String> {
        build_match_expression(s)
    }

    #[test]
    fn quotes_and_ands_bare_words() {
        assert_eq!(m("hello world").unwrap(), r#""hello" AND "world""#);
    }

    #[test]
    fn trailing_star_is_prefix() {
        assert_eq!(m("inv*").unwrap(), r#""inv" *"#);
        assert_eq!(m("inv** oice").unwrap(), r#""inv" * AND "oice""#);
    }

    #[test]
    fn quoted_runs_are_phrases() {
        assert_eq!(m(r#""quick brown" fox"#).unwrap(), r#""quick brown" AND "fox""#);
        assert_eq!(m(r#""quick bro"*"#).unwrap(), r#""quick bro" *"#);
        assert_eq!(m(r#""unterminated phrase"#).unwrap(), r#""unterminated phrase""#);
    }

    #[test]
    fn neutralises_operators() {
        assert_eq!(m("AND NOT OR NEAR").unwrap(), r#""AND" AND "NOT" AND "OR" AND "NEAR""#);
        assert_eq!(m("(a OR b) NOT c").unwrap(), r#""a" AND "OR" AND "b" AND "NOT" AND "c""#);
        assert_eq!(m("subject:foo col:bar").unwrap(), r#""subject foo" AND "col bar""#);
        assert_eq!(
            m("^caret {brace} -minus +plus").unwrap(),
            r#""caret" AND "brace" AND "minus" AND "plus""#
        );
    }

    #[test]
    fn splits_punctuated_words() {
        assert_eq!(m("foo.bar a-b").unwrap(), r#""foo bar" AND "a b""#);
        assert_eq!(m("me@example.com").unwrap(), r#""me example com""#);
    }

    #[test]
    fn passes_unicode_through() {
        assert_eq!(m("résumé 日本語 Straße").unwrap(), r#""résumé" AND "日本語" AND "Straße""#);
    }

    #[test]
    fn none_when_nothing_searchable() {
        for raw in ["", "   ", "\"", "\"\"", "***", "()", "\"  \"*", "!!!", "\" * \""] {
            assert_eq!(m(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn exposes_parsed_terms() {
        let t = |w: &[&str], prefix| SearchTerm {
            words: w.iter().map(|s| s.to_string()).collect(),
            prefix,
        };
        assert_eq!(
            parse_search_terms(r#"a "b c"* d*"#),
            vec![t(&["a"], false), t(&["b", "c"], true), t(&["d"], true)]
        );
    }
}
