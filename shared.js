// Shared between the content script and the history page.

// Each video is stored under its own key ("v:<videoId>") so a progress save
// only rewrites one small entry instead of the whole history.
const PREFIX = 'v:';

const DEFAULTS = {
  tracking: true, // record progress while watching
  resume: true,   // seek to the saved position when reopening a video
  bars: true,     // draw progress bars on thumbnails
};

// Videos watched past this point count as finished: the bar is full and
// reopening them starts from the beginning.
const FINISHED_MARGIN = 15; // seconds before the end

function progressOf(entry) {
  if (!entry || !(entry.d > 0)) return 0;
  if (entry.t >= entry.d - FINISHED_MARGIN) return 1;
  return Math.min(1, Math.max(0, entry.t / entry.d));
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
