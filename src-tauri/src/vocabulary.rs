//! Personliga ordlistor: lagring i en fil (som kan säkerhetskopieras) och efterkorrigering
//! av transkriptet — så att till exempel "Kulturum" blir "Qulturum" oavsett motor.
//!
//! Radformat i en ordlista (en post per rad, `#` inleder kommentar):
//!   Qulturum                       – ordet; liknande stavningar rättas (fuzzy)
//!   Kulturum => Qulturum           – "fel => rätt": exakta felstavningar rättas till rätt ord
//!   =Qulturum                      – bara exakt träff (stora/små bokstäver spelar ingen roll)
//!   angio plastik => angioplastik  – flerordsfel går bra
//!
//! Svenska böjningsändelser bevaras: "Kulturumet" → "Qulturumet".

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct VocabList {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    /// Råtext i radformatet ovan — samma text som användaren redigerar och exporterar.
    #[serde(default)]
    pub(crate) text: String,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub(crate) struct VocabStore {
    #[serde(default)]
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) lists: Vec<VocabList>,
}

// ── Filhantering ────────────────────────────────────────────────────────────

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ordlistor.json"))
}

pub(crate) fn load_store(app: &AppHandle) -> Result<VocabStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(VocabStore { version: 1, lists: vec![] });
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Kunde inte läsa ordlistorna: {e}"))?;
    match serde_json::from_str::<VocabStore>(&raw) {
        Ok(mut s) => {
            s.version = 1;
            Ok(s)
        }
        Err(e) => {
            // Behåll den skadade filen så att inget går förlorat.
            let bad = path.with_extension("json.skadad");
            let _ = fs::copy(&path, &bad);
            Err(format!(
                "Ordlistefilen är skadad ({e}). En kopia sparades som {}.",
                bad.display()
            ))
        }
    }
}

fn write_store(app: &AppHandle, store: &VocabStore) -> Result<(), String> {
    let path = store_path(app)?;
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("Kunde inte spara ordlistorna: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Kunde inte spara ordlistorna: {e}"))
}

fn new_id() -> String {
    format!("l{:x}", chrono::Local::now().timestamp_nanos_opt().unwrap_or_default())
}

#[tauri::command]
pub(crate) fn vocab_load(app: AppHandle) -> Result<VocabStore, String> {
    load_store(&app)
}

#[tauri::command]
pub(crate) fn vocab_save(app: AppHandle, mut store: VocabStore) -> Result<(), String> {
    store.version = 1;
    write_store(&app, &store)
}

/// Mappen där ordlistefilen ligger (för säkerhetskopiering).
#[tauri::command]
pub(crate) fn vocab_dir(app: AppHandle) -> Result<String, String> {
    let p = store_path(&app)?;
    Ok(p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default())
}

/// Lägger till en rad i en ordlista (eller första aktiva/första listan; skapar "Min ordlista"
/// om det inte finns någon). Med `alias` blir raden "alias => term".
#[tauri::command]
pub(crate) fn vocab_add_entry(
    app: AppHandle,
    list_id: Option<String>,
    term: String,
    alias: Option<String>,
) -> Result<VocabStore, String> {
    let term = term.trim().to_string();
    if term.is_empty() {
        return Err("Tomt ord.".into());
    }
    let mut store = load_store(&app)?;
    if store.lists.is_empty() {
        store.lists.push(VocabList { id: new_id(), name: "Min ordlista".into(), enabled: true, text: String::new() });
    }
    let idx = list_id
        .as_deref()
        .and_then(|id| store.lists.iter().position(|l| l.id == id))
        .or_else(|| store.lists.iter().position(|l| l.enabled))
        .unwrap_or(0);
    let line = match alias.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()) {
        Some(a) => format!("{a} => {term}"),
        None => term,
    };
    let list = &mut store.lists[idx];
    if !list.text.lines().any(|l| l.trim().eq_ignore_ascii_case(&line)) {
        if !list.text.is_empty() && !list.text.ends_with('\n') {
            list.text.push('\n');
        }
        list.text.push_str(&line);
        list.text.push('\n');
    }
    list.enabled = true;
    store.version = 1;
    write_store(&app, &store)?;
    Ok(store)
}

// ── Tolkning av ordlistetext ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Entry {
    pub(crate) term: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) fuzzy: bool,
}

pub(crate) fn parse(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if let Some((left, right)) = line.split_once("=>") {
            let term = right.trim();
            if term.is_empty() {
                continue;
            }
            let aliases: Vec<String> = left
                .split(',')
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            let (term, fuzzy) = split_exact(term);
            out.push(Entry { term, aliases, fuzzy });
        } else {
            let (term, fuzzy) = split_exact(line);
            out.push(Entry { term, aliases: vec![], fuzzy });
        }
    }
    out
}

fn split_exact(s: &str) -> (String, bool) {
    match s.strip_prefix('=') {
        Some(rest) => (rest.trim().to_string(), false),
        None => (s.trim().to_string(), true),
    }
}

/// Poster från alla aktiva listor.
pub(crate) fn active_entries(store: &VocabStore) -> Vec<Entry> {
    store.lists.iter().filter(|l| l.enabled).flat_map(|l| parse(&l.text)).collect()
}

/// Text som Whisper får som ledtråd (begränsad längd; Whisper läser bara ~224 tokens).
pub(crate) fn whisper_prompt(entries: &[Entry]) -> Option<String> {
    let mut s = String::new();
    for e in entries {
        if !s.is_empty() {
            s.push_str(", ");
        }
        s.push_str(&e.term);
        if s.chars().count() > 600 {
            break;
        }
    }
    if s.is_empty() { None } else { Some(s) }
}

// ── Efterkorrigering ────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct Change {
    pub(crate) from: String,
    pub(crate) to: String,
}

struct Tok {
    start: usize,
    end: usize,
}

/// Ord = bokstäver/siffror, med bindestreck mellan bokstäver ("Qulturum-teamet").
fn tokenize(text: &str) -> Vec<Tok> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1.is_alphanumeric() {
            let start = chars[i].0;
            let mut j = i;
            while j < chars.len()
                && (chars[j].1.is_alphanumeric()
                    || (chars[j].1 == '-' && j + 1 < chars.len() && chars[j + 1].1.is_alphanumeric()))
            {
                j += 1;
            }
            let end = if j < chars.len() { chars[j].0 } else { text.len() };
            toks.push(Tok { start, end });
            i = j;
        } else {
            i += 1;
        }
    }
    toks
}

/// 1:1-teckenvikning så att byteindex kan hållas i synk: gemener, q→k, c→k, w→v, z→s.
fn fold_char(c: char) -> char {
    let l = c.to_lowercase().next().unwrap_or(c);
    match l {
        'q' | 'c' => 'k',
        'w' => 'v',
        'z' => 's',
        o => o,
    }
}

fn fold(s: &str) -> Vec<char> {
    s.chars().map(fold_char).collect()
}

fn lev(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Längsta tillåtna böjningsändelse efter ordstammen (t.ex. "-et", "-erna", "-s").
const MAX_SUFFIX: usize = 4;

/// Matchar ett ord mot ett ordlisteord. Returnerar byteindex i `token` där en bevarad ändelse
/// börjar (token.len() = ingen ändelse), eller None.
fn match_word(token: &str, term: &str, allow_suffix: bool) -> Option<usize> {
    let ft = fold(token);
    let fw = fold(term);
    let m = fw.len();
    if m == 0 || ft.is_empty() || token.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // Korta ord (≤ 6 tecken) kräver samma stavning efter vikning (q=k, w=v …); längre ord tillåter
    // ett respektive två fel. Annars skulle t.ex. "hjärta" och "hjärna" blandas ihop.
    let tol = match m {
        0..=6 => 0,
        7..=9 => 1,
        _ => 2,
    };
    let max_suffix = if allow_suffix { MAX_SUFFIX } else { 0 };
    let mut best: Option<(usize, usize, usize)> = None; // (avstånd, ändelselängd, stamlängd)
    for l in m.saturating_sub(tol)..=(m + tol) {
        if l == 0 || l > ft.len() {
            continue;
        }
        let suffix = ft.len() - l;
        if suffix > max_suffix {
            continue;
        }
        let d = lev(&ft[..l], &fw);
        if d > tol || (d > 0 && ft[0] != fw[0]) {
            continue;
        }
        let cand = (d, suffix, l);
        if best.map(|b| (cand.0, cand.1) < (b.0, b.1)).unwrap_or(true) {
            best = Some(cand);
        }
    }
    let (_, _, stem_chars) = best?;
    // byteindex för stamslutet
    let idx = token.char_indices().nth(stem_chars).map(|(i, _)| i).unwrap_or(token.len());
    Some(idx)
}

/// Gör första bokstaven versal om originalordet hade det och ordlisteordet är skrivet med gemener.
fn apply_case(term: &str, original: &str) -> String {
    let t_first = term.chars().next();
    let o_first = original.chars().next();
    match (t_first, o_first) {
        (Some(t), Some(o)) if t.is_lowercase() && o.is_uppercase() => {
            let mut c = term.chars();
            let first = c.next().unwrap().to_uppercase().collect::<String>();
            format!("{first}{}", c.as_str())
        }
        _ => term.to_string(),
    }
}

fn only_whitespace_between(text: &str, a_end: usize, b_start: usize) -> bool {
    text[a_end..b_start].chars().all(|c| c.is_whitespace())
}

/// Rättar `text` mot ordlistan. Returnerar ny text och vilka ersättningar som gjordes.
pub(crate) fn correct_text(text: &str, entries: &[Entry]) -> (String, Vec<Change>) {
    if entries.is_empty() || text.trim().is_empty() {
        return (text.to_string(), vec![]);
    }
    let toks = tokenize(text);
    if toks.is_empty() {
        return (text.to_string(), vec![]);
    }
    let words: Vec<&str> = toks.iter().map(|t| &text[t.start..t.end]).collect();
    let mut repl: Vec<(usize, usize, String)> = Vec::new(); // (byte start, byte end, ny text)
    let mut changes: Vec<Change> = Vec::new();
    let mut covered = vec![false; toks.len()];

    let mut i = 0;
    while i < toks.len() {
        if covered[i] {
            i += 1;
            continue;
        }
        let mut done = false;
        for e in entries {
            let term_words: Vec<&str> = e.term.split_whitespace().collect();
            if term_words.is_empty() {
                continue;
            }

            // 1) Uttryckliga felstavningar ("fel => rätt"): hela ord, utan fuzzy.
            for a in &e.aliases {
                let aw: Vec<&str> = a.split_whitespace().collect();
                let k = aw.len();
                if k == 0 || i + k > toks.len() || (i..i + k).any(|x| covered[x]) {
                    continue;
                }
                let ok = (0..k).all(|n| words[i + n].to_lowercase() == aw[n].to_lowercase())
                    && (1..k).all(|n| only_whitespace_between(text, toks[i + n - 1].end, toks[i + n].start));
                if ok {
                    let from = &text[toks[i].start..toks[i + k - 1].end];
                    let to = apply_case(&e.term, from);
                    if from != to {
                        changes.push(Change { from: from.to_string(), to: to.clone() });
                        repl.push((toks[i].start, toks[i + k - 1].end, to));
                    }
                    (i..i + k).for_each(|x| covered[x] = true);
                    done = true;
                    break;
                }
            }
            if done {
                break;
            }

            // 2) Ordlisteordet självt: stavningsnära (eller exakt) träff.
            let k = term_words.len();
            if i + k <= toks.len() && !(i..i + k).any(|x| covered[x]) {
                let spaced = (1..k).all(|n| only_whitespace_between(text, toks[i + n - 1].end, toks[i + n].start));
                if spaced {
                    let mut stems_ok = true;
                    let mut suffix_from: Option<usize> = None;
                    for n in 0..k {
                        let last = n == k - 1;
                        let r = if e.fuzzy {
                            match_word(words[i + n], term_words[n], last)
                        } else if words[i + n].to_lowercase() == term_words[n].to_lowercase() {
                            Some(words[i + n].len())
                        } else {
                            None
                        };
                        match r {
                            Some(idx) => {
                                if last {
                                    suffix_from = Some(idx);
                                }
                            }
                            None => {
                                stems_ok = false;
                                break;
                            }
                        }
                    }
                    if stems_ok {
                        let from = &text[toks[i].start..toks[i + k - 1].end];
                        let last_word = words[i + k - 1];
                        let suffix = &last_word[suffix_from.unwrap_or(last_word.len())..];
                        let to = format!("{}{}", apply_case(&e.term, from), suffix);
                        if from != to {
                            changes.push(Change { from: from.to_string(), to: to.clone() });
                            repl.push((toks[i].start, toks[i + k - 1].end, to));
                        }
                        (i..i + k).for_each(|x| covered[x] = true);
                        done = true;
                    }
                }
            }
            if done {
                break;
            }

            // 3) Ordlisteord av ett ord som skrivits isär i två ("angio plastik" → "angioplastik").
            if k == 1 && e.fuzzy && i + 2 <= toks.len() && !covered[i + 1] && toks[i + 1].start - toks[i].end <= 2
                && only_whitespace_between(text, toks[i].end, toks[i + 1].start)
            {
                let joined = format!("{}{}", words[i], words[i + 1]);
                if fold(&joined).len() >= 6 {
                    if let Some(idx) = match_word(&joined, &e.term, true) {
                        let from = &text[toks[i].start..toks[i + 1].end];
                        let to = format!("{}{}", apply_case(&e.term, &joined), &joined[idx..]);
                        changes.push(Change { from: from.to_string(), to: to.clone() });
                        repl.push((toks[i].start, toks[i + 1].end, to));
                        covered[i] = true;
                        covered[i + 1] = true;
                        done = true;
                    }
                }
            }
            if done {
                break;
            }
        }
        i += 1;
    }

    if repl.is_empty() {
        return (text.to_string(), vec![]);
    }
    repl.sort_by_key(|r| r.0);
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    for (s, e, t) in repl {
        if s < pos {
            continue;
        }
        out.push_str(&text[pos..s]);
        out.push_str(&t);
        pos = e;
    }
    out.push_str(&text[pos..]);
    (out, changes)
}

#[derive(Serialize)]
pub(crate) struct ApplyResult {
    pub(crate) texts: Vec<String>,
    pub(crate) changes: Vec<Change>,
}

/// Kör ordlistan på en lista texter (en per segment) — för "Tillämpa ordlistan" i efterhand.
#[tauri::command]
pub(crate) fn apply_vocabulary(app: AppHandle, texts: Vec<String>) -> Result<ApplyResult, String> {
    let entries = active_entries(&load_store(&app)?);
    let mut changes = Vec::new();
    let texts = texts
        .into_iter()
        .map(|t| {
            let (n, c) = correct_text(&t, &entries);
            changes.extend(c);
            n
        })
        .collect();
    Ok(ApplyResult { texts, changes })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fix(text: &str, list: &str) -> String {
        correct_text(text, &parse(list)).0
    }

    #[test]
    fn kulturum_blir_qulturum() {
        assert_eq!(fix("Vi ses på Kulturum i morgon.", "Qulturum"), "Vi ses på Qulturum i morgon.");
    }

    #[test]
    fn bojningsandelser_bevaras() {
        assert_eq!(fix("Kulturumet har öppnat.", "Qulturum"), "Qulturumet har öppnat.");
        assert_eq!(fix("på kulturums sida", "Qulturum"), "på Qulturums sida");
    }

    #[test]
    fn stavfel_med_ett_tecken_ratas() {
        assert_eq!(fix("Kulturrum", "Qulturum"), "Qulturum");
    }

    #[test]
    fn kortare_ord_och_andra_ord_lamnas() {
        assert_eq!(fix("Vi har mycket kultur här.", "Qulturum"), "Vi har mycket kultur här.");
        assert_eq!(fix("Han bor i Kulturen.", "Qulturum"), "Han bor i Kulturen.");
    }

    #[test]
    fn utan_andring_ger_inga_andringar() {
        let (t, c) = correct_text("Qulturum är bra.", &parse("Qulturum"));
        assert_eq!(t, "Qulturum är bra.");
        assert!(c.is_empty());
    }

    #[test]
    fn felstavning_pil_ratt() {
        assert_eq!(fix("Vi väntar på Ostrom där.", "ostrom, Östrom => Östra Ryd"), "Vi väntar på Östra Ryd där.");
    }

    #[test]
    fn flerordsfel() {
        assert_eq!(fix("en angio plastik gjordes", "angio plastik => angioplastik"), "en angioplastik gjordes");
    }

    #[test]
    fn isarskrivet_ord_slas_ihop() {
        assert_eq!(fix("Han gjorde en angio plastik.", "angioplastik"), "Han gjorde en angioplastik.");
    }

    #[test]
    fn flerordsterm_fuzzy() {
        assert_eq!(
            fix("på Region Jönköpings län idag", "Region Jönköpings län"),
            "på Region Jönköpings län idag"
        );
        assert_eq!(fix("på Region Jonkopings län", "Region Jönköpings län"), "på Region Jönköpings län");
    }

    #[test]
    fn exakt_laage_ror_inte_liknande_ord() {
        assert_eq!(fix("Kulturum", "=Qulturum"), "Kulturum");
        assert_eq!(fix("qulturum", "=Qulturum"), "Qulturum");
    }

    #[test]
    fn gemener_ordlisteord_foljer_originalets_versal() {
        assert_eq!(fix("Angioplastik gjordes", "angioplastic => angioplastik"), "Angioplastik gjordes");
        assert_eq!(fix("angioplastic gjordes", "angioplastic => angioplastik"), "angioplastik gjordes");
    }

    #[test]
    fn kommentarer_och_tomma_rader() {
        assert_eq!(parse("# kommentar\n\nQulturum # fotnot\n").len(), 1);
    }

    #[test]
    fn siffror_och_korta_ord_roras_inte() {
        assert_eq!(fix("Det var 2024 och vi", "2025"), "Det var 2024 och vi");
        assert_eq!(fix("och oss", "ass"), "och oss");
    }

    #[test]
    fn whisper_prompt_av_ord() {
        let e = parse("Qulturum\nfel => Rätt");
        assert_eq!(whisper_prompt(&e).as_deref(), Some("Qulturum, Rätt"));
    }
}
