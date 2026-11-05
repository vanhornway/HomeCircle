// Has the phone's voice started? Android's speech library drops its event
// listeners whenever its queue empties, so "started" can go missing from the
// second line on. Asking the engine whether it's speaking doesn't depend on
// those events: only when it never was, within the time allowed, has it failed.

type Watch = { started: () => void; cancel: () => void };

export function watchStart(isSpeaking: () => Promise<boolean>, onFail: () => void, { withinMs = 2500, everyMs = 250 } = {}): Watch {
  let over = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    over = true;
    if (timer) clearTimeout(timer);
  };
  const deadline = Date.now() + withinMs;
  const check = async () => {
    const speaking = await isSpeaking().catch(() => false);
    if (over) return;
    if (speaking) return stop();
    if (Date.now() >= deadline) {
      stop();
      onFail();
      return;
    }
    timer = setTimeout(check, everyMs);
  };
  timer = setTimeout(check, everyMs);
  return { started: stop, cancel: stop };
}

/** How long a line stays on her screen: long enough to read it slowly. */
export const captionMs = (text: string) => Math.max(6000, text.length * 130);
