//! Makes the startup snapshot (src/snapshot.rs) and finds ICU's data, both for the binary to carry.
//!
//! The snapshot is V8's heap after native/js/boot.ts has loaded Edwin's core and booted it with the shipped
//! Scheme, made here with the same natives and V8 flags the binary uses (the files below are its own).
//! ICU's data comes from EDWIN_ICU_DATA, else from the copy inside the v8 crate's sources.

#[allow(dead_code)]
#[path = "src/bridge.rs"]
mod bridge;
#[allow(dead_code)]
#[path = "src/natives.rs"]
mod natives;
#[allow(dead_code)]
#[path = "src/snapshot.rs"]
mod snapshot;
#[allow(dead_code)]
#[path = "src/sources.rs"]
mod sources;
#[allow(dead_code)]
#[path = "src/sys.rs"]
mod sys;

use std::path::PathBuf;

fn icu_data() -> PathBuf {
    println!("cargo:rerun-if-env-changed=EDWIN_ICU_DATA");
    let found = std::env::var_os("EDWIN_ICU_DATA")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| {
            let home = std::env::var_os("CARGO_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cargo")))?;
            let reg = home.join("registry").join("src");
            std::fs::read_dir(reg)
                .ok()?
                .flatten()
                .map(|d| {
                    d.path()
                        .join("v8-130.0.1/third_party/icu/flutter_desktop/icudtl.dat")
                })
                .find(|p| p.is_file())
        });
    found.unwrap_or_else(|| {
        panic!("ICU data not found: set EDWIN_ICU_DATA to an icudtl.dat for ICU 74")
    })
}

/// The JavaScript sources.rs embeds is each .ts of the core and of js/ stripped beside it (the .js are
/// gitignored): a .js missing or older than its .ts would build the old program, so the build stops.
fn check_stripped() {
    for dir in ["js", "../src"] {
        for e in std::fs::read_dir(dir).expect("read the sources").flatten() {
            let ts = e.path();
            if ts.extension().is_none_or(|x| x != "ts") || ts.to_string_lossy().ends_with(".d.ts") {
                continue;
            }
            let js = ts.with_extension("js");
            let age = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
            if age(&js).is_none_or(|j| Some(j) < age(&ts)) {
                panic!(
                    "{} is missing or older than {}: run `node tools/strip.mts --in-place edwin/src edwin/native/js` in the repository",
                    js.display(),
                    ts.display()
                );
            }
        }
    }
}

fn main() {
    for dir in ["src", "js", "../src", "../scm"] {
        println!("cargo:rerun-if-changed={dir}");
    }
    check_stripped();
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let icu = icu_data();
    println!("cargo:rerun-if-changed={}", icu.display());
    std::fs::copy(&icu, out.join("icudtl.dat")).expect("copy icudtl.dat");
    let data: &'static [u8] = Box::leak(
        std::fs::read(&icu)
            .expect("read icudtl.dat")
            .into_boxed_slice(),
    );
    let blob = std::thread::Builder::new()
        .stack_size(96 << 20)
        .spawn(move || {
            snapshot::init_v8(data);
            natives::start_clock(std::time::Instant::now());
            snapshot::create()
        })
        .unwrap()
        .join()
        .expect("the snapshot thread panicked")
        .unwrap_or_else(|e| panic!("startup snapshot: {e}"));
    std::fs::write(out.join("snapshot.bin"), blob).expect("write snapshot.bin");
}
