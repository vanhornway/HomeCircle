// Times along a cold start, in ms since the JavaScript engine started, so a
// slow launch shows where the time went (Diagnostics, "startup"):
//   js       this file ran: the app's code began to load
//   imports  every module is loaded (screens, background tasks)
//   index    the first screen drew
//   circles  this phone's keys are read
//   tabs     the main screens drew
// Then, from the circle on screen: cacheMs/cacheRows (reading what the phone
// already had), refreshMs (the server's first answer), fetchMs/fetchMode
// (the newest messages) and totalMs.
const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

const marks: Record<string, number> = {};
let reported = false;

export function mark(name: string) {
  if (!(name in marks)) marks[name] = Math.round(now());
}

/** The marks so far, once per run of the app (null after that). */
export function takeStartup(): Record<string, number> | null {
  if (reported) return null;
  reported = true;
  return { ...marks, now: Math.round(now()) };
}

mark('js');
