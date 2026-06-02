use std::path::PathBuf;

use transcribe_soniqo as hypr_transcribe_soniqo;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionOutput {
    text: String,
    duration_seconds: f64,
    words: Vec<hypr_transcribe_soniqo::AlignedWord>,
    error: Option<String>,
}

#[derive(Default)]
struct Args {
    model: Option<String>,
    audio: Option<PathBuf>,
    language: Option<String>,
}

fn main() {
    let result = run().map_err(|error| error.to_string());
    match result {
        Ok(transcript) => {
            println!(
                "{}",
                serde_json::to_string(&TranscriptionOutput {
                    text: transcript.text,
                    duration_seconds: transcript.duration_seconds,
                    words: transcript.words,
                    error: None,
                })
                .unwrap_or_else(|_| "{}".to_string())
            );
        }
        Err(error) => {
            eprintln!("{error}");
            println!(
                "{}",
                serde_json::to_string(&TranscriptionOutput {
                    text: String::new(),
                    duration_seconds: 0.0,
                    words: Vec::new(),
                    error: Some(error),
                })
                .unwrap_or_else(|_| "{}".to_string())
            );
            std::process::exit(1);
        }
    }
}

fn run() -> hypr_transcribe_soniqo::Result<hypr_transcribe_soniqo::FileTranscript> {
    let args = parse_args().map_err(hypr_transcribe_soniqo::Error::Bridge)?;
    let model = args
        .model
        .ok_or_else(|| hypr_transcribe_soniqo::Error::Bridge("missing --model".to_string()))?
        .parse::<hypr_transcribe_soniqo::SoniqoModel>()?;
    let audio = args
        .audio
        .ok_or_else(|| hypr_transcribe_soniqo::Error::Bridge("missing --audio".to_string()))?;

    hypr_transcribe_soniqo::transcribe_file(model, audio, args.language.as_deref())
}

fn parse_args() -> Result<Args, String> {
    let mut parsed = Args::default();
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => parsed.model = Some(next_arg(&mut args, "--model")?),
            "--audio" => parsed.audio = Some(PathBuf::from(next_arg(&mut args, "--audio")?)),
            "--language" => parsed.language = Some(next_arg(&mut args, "--language")?),
            "--help" | "-h" => {
                return Err(
                    "usage: char-sidecar-soniqo-transcriber --model <model> --audio <path> [--language <bcp47>]"
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
