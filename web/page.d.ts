// Page-only declarations (not shared with tests/, which see Node's own): keys.ts's UMD wrapper looks for
// CommonJS's module, which exists when tests/keys.test.mts loads the file under Node.
declare var module: { exports: unknown } | undefined;
