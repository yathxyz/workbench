// Strips TypeScript's types from the page's sources, for the browser (the nix web root) and for a repo checkout.
//
//   node tools/strip.mts OUT FILE.ts...    write OUT/FILE.js for each FILE.ts
//   node tools/strip.mts --web WEB OUT     OUT becomes a web root: WEB (the web/ directory) with every .ts as .js,
//                                           without the .ts, .d.ts and tsconfig files (nix/web.nix uses it; vendor/
//                                           and fonts/ come from nix, so serving a checkout means copying them in)
//
// Node's stripper replaces each type with whitespace, so a stripped file keeps every line and column of its .ts
// and a stack trace from the browser points at the source. It accepts erasable syntax only (the configs set
// erasableSyntaxOnly), so a construct that would need code generation fails here instead of changing the program.
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

export function strip(src: string, file: string): string {
  try { return stripTypeScriptTypes(src, { mode: 'strip' }); } catch (e) { throw new Error(`${file}: ${e.message}`); }
}

const SKIP = (f: string) => f.endsWith('.d.ts') || /^tsconfig.*\.json$/.test(f);

export function stripWeb(webDir: string, out: string): string[] {
  const written: string[] = [];
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(webDir)) {
    const src = path.join(webDir, f);
    if (SKIP(f) || !fs.statSync(src).isFile()) continue;
    if (f.endsWith('.ts')) {
      const dst = path.join(out, f.slice(0, -3) + '.js');
      fs.writeFileSync(dst, strip(fs.readFileSync(src, 'utf8'), src)); written.push(dst);
    } else fs.copyFileSync(src, path.join(out, f));
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.removeAllListeners('warning'); // stripTypeScriptTypes is experimental in Node 24 and says so on every run
  const args = process.argv.slice(2);
  if (args[0] === '--web' && args.length === 3) stripWeb(args[1], args[2]);
  else if (args.length >= 2 && !args[0].startsWith('-')) {
    fs.mkdirSync(args[0], { recursive: true });
    for (const f of args.slice(1)) fs.writeFileSync(path.join(args[0], path.basename(f).replace(/\.m?ts$/, '.js')), strip(fs.readFileSync(f, 'utf8'), f));
  } else { console.error('usage: node tools/strip.mts OUT FILE.ts... | node tools/strip.mts --web WEB OUT'); process.exit(2); }
}
