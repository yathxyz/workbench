# F-A7

Camera per device in `localStorage` (`wb-cam-<host>`, try/catch), never saved in the board, so pans don't dirty it.
On `/rpc` `board{etag}`:

- an etag equal to our last save is ignored;
- with a save in flight, check again after it completes;
- a clean tab refetches silently and applies the nodes but not the camera;
- a tab with unsaved edits shows the conflict bar with counts ("this tab: N changes; server: newer").

Board v-field compatibility: the stored `cam` is left untouched on write-back.
