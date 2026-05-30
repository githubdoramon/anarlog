mod batch;
mod streaming;
pub use streaming::*;

use std::path::Path;

use owhisper_interface::stream::{Extra, Metadata, ModelInfo};
use serde::Deserialize;
use serde_json::json;

pub(crate) struct Segment<'a> {
    pub text: &'a str,
    pub start: f64,
    pub duration: f64,
    pub confidence: f64,
}

pub(crate) fn build_metadata(model_path: &Path) -> Metadata {
    let model_name = model_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("cactus")
        .to_string();

    Metadata {
        model_info: ModelInfo {
            name: model_name,
            version: "1.0".to_string(),
            arch: "cactus".to_string(),
        },
        extra: Some(Extra::default().into()),
        ..Default::default()
    }
}

#[derive(Deserialize)]
struct TokenizerJson {
    added_tokens: Vec<AddedTokenizerToken>,
}

#[derive(Deserialize)]
struct AddedTokenizerToken {
    id: u32,
    content: String,
}

pub(crate) fn repair_whisper_special_tokens(model_path: &Path) -> std::io::Result<bool> {
    let special_tokens_path = model_path.join("special_tokens.json");
    let tokenizer_path = model_path.join("tokenizer.json");

    if !special_tokens_path.exists() || !tokenizer_path.exists() {
        return Ok(false);
    }

    let current = std::fs::read_to_string(&special_tokens_path)?;
    if current.contains("<|startoftranscript|>") && current.contains("<|0.00|>") {
        return Ok(false);
    }

    let tokenizer_json: TokenizerJson =
        serde_json::from_str(&std::fs::read_to_string(&tokenizer_path)?)
            .map_err(std::io::Error::other)?;

    let whisper_tokens = tokenizer_json
        .added_tokens
        .into_iter()
        .filter(|token| token.content.starts_with("<|") && token.content.ends_with("|>"))
        .collect::<Vec<_>>();

    if whisper_tokens.is_empty() {
        return Ok(false);
    }

    let special_tokens = whisper_tokens
        .iter()
        .map(|token| (token.id.to_string(), json!(token.content)))
        .collect::<serde_json::Map<_, _>>();
    let additional_special_tokens = whisper_tokens
        .iter()
        .map(|token| {
            json!({
                "token": token.content,
                "id": token.id,
            })
        })
        .collect::<Vec<_>>();

    let repaired = json!({
        "eos_token_id": 50257,
        "pad_token_id": 50257,
        "bos_token_id": 50257,
        "unk_token_id": 50257,
        "vocab_size": 51865,
        "model_max_length": 1024,
        "special_tokens": special_tokens,
        "additional_special_tokens": additional_special_tokens,
    });

    std::fs::write(
        &special_tokens_path,
        serde_json::to_string_pretty(&repaired).map_err(std::io::Error::other)?,
    )?;

    Ok(true)
}

pub(crate) fn build_transcribe_options(
    params: &owhisper_interface::ListenParams,
    min_chunk_sec: Option<f32>,
) -> hypr_cactus::TranscribeOptions {
    let (custom_vocabulary, vocabulary_boost) =
        deepgram_keywords_to_cactus_vocabulary(&params.keywords);
    let language = hypr_cactus::constrain_to(&params.languages);

    tracing::info!(
        languages = ?params.languages,
        selected_language = ?language,
        keyword_count = params.keywords.len(),
        min_chunk_sec = ?min_chunk_sec,
        "cactus_transcribe_options_resolved"
    );

    hypr_cactus::TranscribeOptions {
        language,
        min_chunk_size: min_chunk_sec.map(|seconds| (seconds * 16_000.0) as u32),
        custom_vocabulary: (!custom_vocabulary.is_empty()).then_some(custom_vocabulary),
        vocabulary_boost,
        ..Default::default()
    }
}

pub(crate) fn deepgram_keywords_to_cactus_vocabulary(
    keywords: &[String],
) -> (Vec<String>, Option<f32>) {
    let mut custom_vocabulary = Vec::new();
    let mut vocabulary_boost = None;

    for keyword in keywords {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            continue;
        }

        let parsed = keyword.rsplit_once(':').and_then(|(term, intensifier)| {
            let term = term.trim();
            let intensifier = intensifier.trim().parse::<f32>().ok()?;
            (!term.is_empty()).then_some((term, intensifier))
        });

        match parsed {
            Some((term, intensifier)) if intensifier > 0.0 => {
                custom_vocabulary.push(term.to_string());
                vocabulary_boost = Some(
                    vocabulary_boost.map_or(intensifier, |current: f32| current.max(intensifier)),
                );
            }
            Some(_) => {}
            None => {
                custom_vocabulary.push(keyword.to_string());
                vocabulary_boost = Some(vocabulary_boost.map_or(1.0, |current: f32| current));
            }
        }
    }

    (custom_vocabulary, vocabulary_boost)
}

pub(crate) fn clean_transcript_text(text: &str) -> String {
    text.split_whitespace()
        .filter(|token| !is_transcript_control_token(token))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn transcript_control_tokens(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|token| is_transcript_control_token(token))
        .map(ToString::to_string)
        .collect()
}

fn is_transcript_control_token(token: &str) -> bool {
    let token = token.trim();

    if token.starts_with("<|") && token.ends_with("|>") {
        return true;
    }

    token.strip_prefix("</").is_some_and(|rest| {
        !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit() || c == '.')
    })
}

#[cfg(test)]
mod tests {
    use super::{
        clean_transcript_text, deepgram_keywords_to_cactus_vocabulary, transcript_control_tokens,
    };

    #[test]
    fn cleans_whisper_control_tokens_from_transcripts() {
        assert_eq!(
            clean_transcript_text("<|startoftranscript|> hello </1 world </12.5"),
            "hello world"
        );
        assert_eq!(
            transcript_control_tokens("<|startoftranscript|> hello </1 world </12.5"),
            vec!["<|startoftranscript|>", "</1", "</12.5"]
        );
    }

    #[test]
    fn repairs_incomplete_whisper_special_tokens_from_tokenizer_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("special_tokens.json"),
            r#"{"special_tokens":{"50257":"<|endoftext|>"}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("tokenizer.json"),
            r#"{
              "added_tokens": [
                {"id": 50257, "content": "<|endoftext|>"},
                {"id": 50258, "content": "<|startoftranscript|>"},
                {"id": 50363, "content": "<|notimestamps|>"},
                {"id": 50364, "content": "<|0.00|>"}
              ]
            }"#,
        )
        .unwrap();

        assert!(super::repair_whisper_special_tokens(dir.path()).unwrap());

        let repaired = std::fs::read_to_string(dir.path().join("special_tokens.json")).unwrap();
        assert!(repaired.contains("<|startoftranscript|>"));
        assert!(repaired.contains("<|notimestamps|>"));
        assert!(repaired.contains("<|0.00|>"));
    }

    #[test]
    fn keeps_plain_keywords_as_vocabulary() {
        let (vocabulary, boost) = deepgram_keywords_to_cactus_vocabulary(&[
            "Hyprnote".to_string(),
            "project atlas".to_string(),
        ]);

        assert_eq!(vocabulary, vec!["Hyprnote", "project atlas"]);
        assert_eq!(boost, Some(1.0));
    }

    #[test]
    fn uses_strongest_positive_intensifier() {
        let (vocabulary, boost) = deepgram_keywords_to_cactus_vocabulary(&[
            "Hyprnote:1.5".to_string(),
            "cactus:3".to_string(),
        ]);

        assert_eq!(vocabulary, vec!["Hyprnote", "cactus"]);
        assert_eq!(boost, Some(3.0));
    }

    #[test]
    fn drops_non_positive_intensifiers() {
        let (vocabulary, boost) = deepgram_keywords_to_cactus_vocabulary(&[
            "ignore-me:0".to_string(),
            "suppress-me:-10".to_string(),
            "keep-me".to_string(),
        ]);

        assert_eq!(vocabulary, vec!["keep-me"]);
        assert_eq!(boost, Some(1.0));
    }

    #[test]
    fn keeps_colons_when_suffix_is_not_a_number() {
        let (vocabulary, boost) =
            deepgram_keywords_to_cactus_vocabulary(&["namespace:term".to_string()]);

        assert_eq!(vocabulary, vec!["namespace:term"]);
        assert_eq!(boost, Some(1.0));
    }
}
