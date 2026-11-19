# F-A9

Self-hosted fonts per §6.2.
The `sw.js` cache is `workbench-shell-v3`.
Installing it caches the shell, then reads the cached `fonts.css` and caches every font file it names, so a launch after one visit renders in them offline.
Font files are served cache-first, and `fonts.css` stays with the shell (network-first).
`index.html` preloads the Regular mono face.
Activating deletes every cache with another name.
