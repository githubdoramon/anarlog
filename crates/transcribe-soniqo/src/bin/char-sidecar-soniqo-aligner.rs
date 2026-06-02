use std::path::PathBuf;

use transcribe_soniqo as hypr_transcribe_soniqo;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentOutput {
    words: Vec<hypr_transcribe_soniqo::AlignedWord>,
    error: Option<String>,
}

#[derive(Default)]
struct Args {
    audio: Option<PathBuf>,
    text: Option<String>,
    language: Option<String>,
}

fn main() {
    let result = run().map_err(|error| error.to_string());
    match result {
        Ok(words) => {
            println!(
                "{}",
                serde_json::to_string(&AlignmentOutput { words, error: None })
                    .unwrap_or_else(|_| "{}".to_string())
            );
        }
        Err(error) => {
            eprintln!("{error}");
            println!(
                "{}",
                serde_json::to_string(&AlignmentOutput {
                    words: Vec::new(),
                    error: Some(error),
                })
                .unwrap_or_else(|_| "{}".to_string())
            );
            std::process::exit(1);
        }
    }
}

fn run() -> hypr_transcribe_soniqo::Result<Vec<hypr_transcribe_soniqo::AlignedWord>> {
    let args = parse_args().map_err(hypr_transcribe_soniqo::Error::Bridge)?;
    let audio = args
        .audio
        .ok_or_else(|| hypr_transcribe_soniqo::Error::Bridge("missing --audio".to_string()))?;
    let text = args
        .text
        .ok_or_else(|| hypr_transcribe_soniqo::Error::Bridge("missing --text".to_string()))?;

    hypr_transcribe_soniqo::align_file(audio, text, args.language.as_deref())
}

fn parse_args() -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--audio" => parsed.audio = Some(PathBuf::from(next_arg(&mut args, "--audio")?)),
            "--text" => parsed.text = Some(next_arg(&mut args, "--text")?),
            "--language" => parsed.language = Some(next_arg(&mut args, "--language")?),
            "--help" | "-h" => {
                return Err(
                    "usage: char-sidecar-soniqo-aligner --audio <path> --text <text> [--language <bcp47>]"
                        .to_string(),
                );
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    Ok(parsed)
}

fn next_arg(args: &mut impl Iterator<Item = String>, name: &str) -> Result<String, String> {
    args.next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing value for {name}"))
}
