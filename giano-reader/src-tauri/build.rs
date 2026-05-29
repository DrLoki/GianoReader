use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Copy pdfium native library to the output directory so it's found at runtime.
    // The library must be placed in the workspace-root `pdfium/` folder.
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    // OUT_DIR is something like target/debug/build/<pkg>/out — walk up to target/<profile>/
    let target_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("Cannot determine target directory");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // pdfium/ is at workspace root, two levels up from src-tauri/
    let pdfium_dir = manifest_dir.join("..").join("..").join("pdfium");

    let (lib_name, lib_name_alt) = if cfg!(target_os = "windows") {
        ("pdfium.dll", "pdfium.dll")
    } else if cfg!(target_os = "macos") {
        ("libpdfium.dylib", "libpdfium.dylib")
    } else {
        ("libpdfium.so", "libpdfium.so")
    };

    let src = pdfium_dir.join(lib_name);
    let src_alt = pdfium_dir.join(lib_name_alt);

    let source = if src.exists() {
        src
    } else if src_alt.exists() {
        src_alt
    } else {
        println!(
            "cargo:warning=pdfium library not found at {}. PDF conversion will not work. See pdfium/README.md for instructions.",
            src.display()
        );
        return;
    };

    let dest = target_dir.join(lib_name);
    if !dest.exists() || fs::metadata(&source).unwrap().modified().unwrap()
        > fs::metadata(&dest).unwrap().modified().unwrap()
    {
        fs::copy(&source, &dest).unwrap_or_else(|e| {
            panic!(
                "Failed to copy pdfium library from {} to {}: {}",
                source.display(),
                dest.display(),
                e
            );
        });
        println!("cargo:warning=Copied {} to {}", source.display(), dest.display());
    }

    // Re-run if the library file changes
    println!("cargo:rerun-if-changed={}", source.display());
}
