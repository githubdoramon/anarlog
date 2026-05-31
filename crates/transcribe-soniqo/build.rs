#[cfg(target_os = "macos")]
use std::{
    collections::BTreeSet,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(target_os = "macos")]
fn swift_runtime_rpaths() -> Vec<String> {
    let mut paths = BTreeSet::from([PathBuf::from("/usr/lib/swift")]);

    if let Some(swift_bin) = swift_bin_path()
        && let Some(toolchain_root) = swift_bin
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
    {
        paths.insert(toolchain_root.join("lib/swift/macosx"));
    }

    paths
        .into_iter()
        .filter(|path| path.exists())
        .map(|path| path.display().to_string())
        .collect()
}

#[cfg(target_os = "macos")]
fn swift_bin_path() -> Option<PathBuf> {
    let output = Command::new("xcrun")
        .args(["--find", "swift"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8(output.stdout).ok()?;
    let path = path.trim();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

#[cfg(target_os = "macos")]
fn target_is_macos_apple_silicon() -> bool {
    env::var("CARGO_CFG_TARGET_OS").is_ok_and(|value| value == "macos")
        && env::var("CARGO_CFG_TARGET_ARCH").is_ok_and(|value| value == "aarch64")
}

#[cfg(target_os = "macos")]
fn build_mlx_metallib() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let swift_build_dir = out_dir.join("swift-rs/soniqo-swift");
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        panic!("failed to resolve Cargo profile directory from OUT_DIR");
    };
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let cached_metallib = mlx_metallib_candidates(&profile_dir, &profile)
        .into_iter()
        .find(|path| valid_mlx_metallib(path));

    let metallib = if let Some(path) = cached_metallib {
        path
    } else {
        let script = swift_build_dir.join("checkouts/speech-swift/scripts/build_mlx_metallib.sh");

        if !script.exists() {
            panic!("missing MLX metallib build script at {}", script.display());
        }

        let status = Command::new(&script)
            .arg(&profile)
            .env("BUILD_DIR", &swift_build_dir)
            .status()
            .expect("failed to run MLX metallib build script");

        if !status.success() {
            panic!("failed to build MLX metallib");
        }

        find_mlx_metallib(&swift_build_dir).unwrap_or_else(|| {
            panic!("MLX metallib build completed but mlx.metallib was not found")
        })
    };

    copy_mlx_metallib(&metallib, &profile_dir.join("mlx.metallib"));
    let deps_dir = profile_dir.join("deps");
    if deps_dir.exists() {
        copy_mlx_metallib(&metallib, &deps_dir.join("mlx.metallib"));
    }

    println!("cargo:rerun-if-changed=swift-lib/Package.resolved");
}

#[cfg(target_os = "macos")]
fn mlx_metallib_candidates(profile_dir: &Path, profile: &str) -> Vec<PathBuf> {
    let mut candidates = vec![
        profile_dir.join("mlx.metallib"),
        profile_dir.join("deps/mlx.metallib"),
    ];

    if let Ok(manifest_dir) = env::var("CARGO_MANIFEST_DIR") {
        let repo_target_profile = PathBuf::from(manifest_dir)
            .parent()
            .and_then(Path::parent)
            .map(|repo_root| {
                candidates.extend(repo_mlx_metallib_candidates(repo_root, profile));
                repo_root.join("target").join(profile)
            });

        if let Some(repo_target_profile) = repo_target_profile {
            candidates.push(repo_target_profile.join("mlx.metallib"));
            candidates.push(repo_target_profile.join("deps/mlx.metallib"));
        }
    }

    candidates
}

#[cfg(target_os = "macos")]
fn repo_mlx_metallib_candidates(repo_root: &Path, profile: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let worktrees_dir = repo_root.join(".worktrees");
    let Ok(entries) = fs::read_dir(worktrees_dir) else {
        return candidates;
    };

    for entry in entries.flatten() {
        let root = entry.path();
        candidates.push(root.join("target").join(profile).join("mlx.metallib"));
        candidates.push(
            root.join("target")
                .join(profile)
                .join("deps")
                .join("mlx.metallib"),
        );
        candidates.push(
            root.join("apps/desktop/src-tauri/target")
                .join(profile)
                .join("mlx.metallib"),
        );
        candidates.push(
            root.join("apps/desktop/src-tauri/target")
                .join(profile)
                .join("deps")
                .join("mlx.metallib"),
        );
    }

    candidates
}

#[cfg(target_os = "macos")]
fn find_mlx_metallib(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];

    while let Some(path) = stack.pop() {
        let entries = std::fs::read_dir(path).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.file_name().is_some_and(|name| name == "mlx.metallib")
                && valid_mlx_metallib(&path)
            {
                return Some(path);
            }
            if path.is_dir() {
                stack.push(path);
            }
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn valid_mlx_metallib(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
}

#[cfg(target_os = "macos")]
fn copy_mlx_metallib(source: &Path, destination: &Path) {
    let same_file = source
        .canonicalize()
        .ok()
        .zip(destination.canonicalize().ok())
        .is_some_and(|(source, destination)| source == destination);

    if same_file {
        return;
    }

    std::fs::copy(source, destination).unwrap_or_else(|error| {
        panic!(
            "failed to copy MLX metallib from {} to {}: {error}",
            source.display(),
            destination.display()
        )
    });
}

fn main() {
    #[cfg(target_os = "macos")]
    {
        if !target_is_macos_apple_silicon() {
            println!(
                "cargo:warning=Soniqo speech-swift linking is only available on macOS Apple Silicon"
            );
            return;
        }

        swift_rs::SwiftLinker::new("15.0")
            .with_package("soniqo-swift", "./swift-lib/")
            .link();
        build_mlx_metallib();

        for path in swift_runtime_rpaths() {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{path}");
        }

        println!("cargo:rustc-link-lib=c++");
        println!("cargo:rerun-if-changed=swift-lib/src");
        println!("cargo:rerun-if-changed=swift-lib/Package.swift");
    }

    #[cfg(not(target_os = "macos"))]
    {
        println!(
            "cargo:warning=Soniqo speech-swift linking is only available on macOS Apple Silicon"
        );
    }
}
