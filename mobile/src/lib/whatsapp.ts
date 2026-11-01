// Open WhatsApp from HomeCircle: a chat with someone, or a group call link.
//
// WhatsApp has no link that starts a call by itself. A 1-on-1 "call" opens
// the person's chat (optionally with a line already typed in), one tap from
// WhatsApp's own call icon. A group call opens a WhatsApp call link
// (https://call.whatsapp.com/video/…) that an admin saved for the circle,
// which lands in WhatsApp's call lobby. Number cleaning and link building are
// in whatsappCore.ts (and tested there).
//
// Permissions. None at run time: no contacts, no phone, no accessibility. The
// build must declare that this app may ask about WhatsApp (app.json):
//  - Android 11+ hides other apps unless the manifest has <queries> for them:
//    com.whatsapp, com.whatsapp.w4b (Business) and the whatsapp:// scheme, set
//    through expo-build-properties' `android.manifestQueries`.
//  - iOS only lets canOpenURL ask about schemes in LSApplicationQueriesSchemes:
//    "whatsapp", set through `ios.infoPlist`.
// Without these, "is WhatsApp installed?" always answers no.
//
// Errors. Nothing here throws. Each function returns an Outcome:
//  - bad_number: the number is empty, too short, has letters, or has no
//    country code (it is never guessed); `message` says which, in words.
//  - bad_link: not an https://call.whatsapp.com/video|voice/… link.
//  - not_installed: WhatsApp isn't on this phone. showOutcome offers the store
//    (market:// then the Play Store page; the App Store on iOS) or the browser
//    (wa.me, or the call link's own page).
//  - failed: the phone refused to open it.
// The number is never put in a message, a log or a link other than the one
// opened here; the circle keeps it sealed (see CircleClient.phoneOf).
import { Linking, Platform } from 'react-native';
import { NUMBER_PROBLEMS, chatUrls, cleanCallUrl, cleanNumber, storeUrls } from './whatsappCore';
import { showSheet } from './sheet';

export type Outcome =
  | { ok: true; via: 'app' | 'web' | 'store' }
  | { ok: false; reason: 'bad_number' | 'bad_link' | 'failed'; message: string }
  | { ok: false; reason: 'not_installed'; message: string; web: string };

/** Whether WhatsApp (or WhatsApp Business) is installed. Needs the build's query declarations (see above). */
export async function whatsappInstalled(): Promise<boolean> {
  try {
    return await Linking.canOpenURL('whatsapp://send');
  } catch {
    return false;
  }
}

/** Open the first of these that the phone accepts. */
async function openFirst(urls: string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // try the next
    }
  }
  return false;
}

/**
 * Open a WhatsApp chat with this number (any international format, "+92 300
 * 1234567"), with `message` typed in but not sent. The app link first, wa.me
 * if the app link fails, and `not_installed` (with the wa.me link) when
 * WhatsApp isn't here.
 */
export async function openChat(phoneNumber: string, message?: string | null): Promise<Outcome> {
  const n = cleanNumber(phoneNumber);
  if (!n.ok) return { ok: false, reason: 'bad_number', message: NUMBER_PROBLEMS[n.problem] };
  const { app, web } = chatUrls(n.digits, message);
  if (!(await whatsappInstalled())) return { ok: false, reason: 'not_installed', message: 'WhatsApp isn’t installed on this phone.', web };
  if (await openFirst([app])) return { ok: true, via: 'app' };
  if (await openFirst([web])) return { ok: true, via: 'web' };
  return { ok: false, reason: 'failed', message: 'WhatsApp didn’t open.' };
}

/** Open a WhatsApp call link (https://call.whatsapp.com/…), into WhatsApp's call lobby. */
export async function openGroupCallLink(callUrl: string): Promise<Outcome> {
  const url = cleanCallUrl(callUrl);
  if (!url) return { ok: false, reason: 'bad_link', message: 'That isn’t a WhatsApp call link. It starts with https://call.whatsapp.com/' };
  if (!(await whatsappInstalled())) return { ok: false, reason: 'not_installed', message: 'WhatsApp isn’t installed on this phone.', web: url };
  if (await openFirst([url])) return { ok: true, via: 'app' };
  return { ok: false, reason: 'failed', message: 'The call link didn’t open.' };
}

/** The store page for WhatsApp: Play Store app, then its web page; the App Store on iOS. */
export async function openWhatsappStore(): Promise<Outcome> {
  return (await openFirst(storeUrls(Platform.OS))) ? { ok: true, via: 'store' } : { ok: false, reason: 'failed', message: 'The store didn’t open.' };
}

/** Open a link in the phone's browser. */
export async function openInBrowser(url: string): Promise<Outcome> {
  return (await openFirst([url])) ? { ok: true, via: 'web' } : { ok: false, reason: 'failed', message: 'The browser didn’t open.' };
}

/** Say what went wrong, and for a missing WhatsApp offer the store or the browser. Does nothing on success. */
export function showOutcome(o: Outcome) {
  if (o.ok) return;
  if (o.reason === 'not_installed') {
    showSheet('WhatsApp isn’t installed', 'Install it to call from here, or open the link in your browser.', [
      { text: 'Get WhatsApp', onPress: () => void openWhatsappStore().then(showOutcome) },
      { text: 'Open in browser', onPress: () => void openInBrowser(o.web).then(showOutcome) },
      { text: 'Cancel', style: 'cancel' },
    ]);
    return;
  }
  showSheet(o.reason === 'bad_number' ? 'Check the phone number' : o.reason === 'bad_link' ? 'Check the call link' : 'Couldn’t open WhatsApp', o.message);
}
