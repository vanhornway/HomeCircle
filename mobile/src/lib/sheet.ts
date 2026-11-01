/**
 * Confirmations and notices as a bottom sheet (see ConfirmHost). Same call as
 * `Alert.alert(title, message, buttons)`, so it works from components and from
 * plain modules alike. One sheet at a time; the next waits its turn.
 *
 *   showSheet('Delete it?', 'This can’t be undone.', [
 *     { text: 'Cancel', style: 'cancel' },
 *     { text: 'Delete', style: 'destructive', onPress: remove },
 *   ]);
 *
 * With no buttons it is a notice with one OK. The first button that isn't
 * Cancel is the main one; a destructive one is drawn in red.
 */
export type SheetButton = { text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void };
export type SheetRequest = { id: number; title: string; message?: string; buttons: SheetButton[] };

let nextId = 1;
let queue: SheetRequest[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showSheet(title: string, message?: string, buttons?: SheetButton[]) {
  queue = [...queue, { id: nextId++, title, message, buttons: buttons?.length ? buttons : [{ text: 'OK' }] }];
  emit();
}

/** An error or result with nothing to decide: one line and OK. */
export const notice = (title: string, message?: string) => showSheet(title, message);

/** Resolves true when the main button is pressed, false on Cancel or tapping outside. */
export function confirm(title: string, message: string | undefined, yes: string, { destructive = false } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    showSheet(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => done(false) },
      { text: yes, style: destructive ? 'destructive' : 'default', onPress: () => done(true) },
    ]);
    // Dismissed without choosing (tap outside, back): treated as Cancel.
    dismissHooks.set(nextId - 1, () => done(false));
  });
}

const dismissHooks = new Map<number, () => void>();

export const currentSheet = (): SheetRequest | undefined => queue[0];

export function subscribeSheet(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Closes the sheet on screen; `onPress` of the chosen button runs after it's gone. */
export function closeSheet(chosen?: SheetButton) {
  const req = queue[0];
  if (!req) return;
  queue = queue.slice(1);
  const hook = dismissHooks.get(req.id);
  dismissHooks.delete(req.id);
  emit();
  if (chosen) chosen.onPress?.();
  else hook?.();
}
