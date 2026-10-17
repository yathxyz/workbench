//! The startup snapshot: V8's heap after native/js/boot.js has loaded the core and booted it with the shipped
//! Scheme. build.rs makes it with this code; main.rs restores it, then runs main.js for this process.

use crate::natives;

/// V8 as edwin runs it: the evaluator's stack, and ICU's data for \p{...} classes. Making and restoring the
/// snapshot must use the same flags.
pub fn init_v8(icu: &'static [u8]) {
    let _ = v8::icu::set_common_data_74(icu);
    v8::V8::set_flags_from_string("--stack-size=65536");
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();
}

#[allow(dead_code)] // build.rs calls it; the binary only restores
/// Run the snapshot's half of startup in a fresh isolate and serialize it. Err names the source that threw.
pub fn create() -> Result<Vec<u8>, String> {
    let mut iso = v8::Isolate::snapshot_creator(Some(natives::external_refs()), None);
    let failed = (|| -> Result<(), String> {
        let scope = &mut v8::HandleScope::new(&mut iso);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        natives::install(scope, context);
        for name in [
            "native/prelude",
            "native/host-native",
            "native/term",
            "native/boot",
        ] {
            if !natives::run_source(scope, name) {
                return Err(format!("{name} failed while making the startup snapshot"));
            }
            scope.perform_microtask_checkpoint();
        }
        let src = v8::String::new(scope, "__native.freeze()").unwrap();
        v8::Script::compile(scope, src, None)
            .and_then(|s| s.run(scope))
            .ok_or("freeze failed")?;
        scope.set_default_context(context);
        Ok(())
    })();
    if let Err(e) = failed {
        // A snapshot creator may not be dropped without making its blob; this process is ending anyway.
        std::mem::forget(iso);
        return Err(e);
    }
    iso.create_blob(v8::FunctionCodeHandling::Keep)
        .map(|b| b.to_vec())
        .ok_or_else(|| "V8 made no snapshot".into())
}
