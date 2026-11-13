// Types for @homecircle/core (the implementation is plain JS so browsers can
// load it without a build step).

export interface Envelope {
  epoch: number;
  nonce: string;
  ct: string;
}

export interface Storage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type Role = 'owner' | 'admin' | 'member';

export interface Member {
  id: string;
  role: Role;
  removed: boolean;
  joinedAt: number;
  lastSeenAt: number | null;
  isMe: boolean;
  name: string;
  color: string;
  verified: boolean;
  current: boolean;
  keyChanged: boolean;
  safetyNumber: string;
  /** 'agent' for the circle's agent (it's never in memberList()). */
  kind?: 'person' | 'agent';
  /** Their chirp sound (one of CHIRP_SOUNDS), or null if they haven't picked one. */
  chirp?: ChirpSound | null;
  /** Their he/she for languages whose verbs need it, from their own profile. */
  g?: Gender | null;
  /** Their own photo, if they added one (an encrypted file). */
  photo?: PhotoRef | null;
  /** Their phone number ("+15551234567"), if they added one to their profile. */
  phone?: string | null;
}

export type ChirpSound = 'robin' | 'wren' | 'finch' | 'chickadee' | 'cardinal' | 'bluebird' | 'canary' | 'sparrow' | 'lark' | 'dove';
export const CHIRP_SOUNDS: ChirpSound[];
/** "+" and 8–15 digits, from a number typed any way with a country code; null otherwise. */
export function cleanPhone(p: unknown): string | null;
/** A WhatsApp call link as kept (https://call.whatsapp.com/video/… or /voice/…), or null. */
export function cleanCallLink(u: unknown): string | null;
/** He or she, for languages whose verbs change with the person (Urdu). */
export type Gender = 'm' | 'f';
export const GENDERS: Gender[];

/** An encrypted photo: the file's id on the server and its key (which only sealed records carry). */
export interface PhotoRef {
  id: string;
  key: string;
  at: number;
}

/** How a tracker reports: minutes between reports while moving and while still, quiet hours, SOS on or off. */
export type TrackerMode = 'carried' | 'car' | 'pet' | 'luggage' | 'keys' | 'other';

export interface TrackerSettings {
  /** What it's for: carried by someone (`carriedBy`), in a car, on a pet, in luggage, on keys, or something else. */
  mode: TrackerMode;
  moving: number;
  still: number;
  quiet: { from: string; to: string } | null;
  sos: boolean;
  /** A Meshtastic tracker's node id ("!a1b2c3d4"), set by the home base that sends for it. */
  node: string | null;
  /** The member who carries this tracker: their pin falls back to it when their phone is quiet. */
  carriedBy: string | null;
  /** A Meshtastic tracker's own settings, where an admin chose them; null follows the circle's. */
  custom: TrackerCustom | null;
}

/** One Meshtastic tracker's own settings: only what differs from the circle's (null fields follow the circle). */
export interface TrackerCustom {
  /** Minutes between positions while moving, 1 to 60. */
  moving: number | null;
  /** Minutes between positions otherwise, 5 to 720. */
  still: number | null;
  /** Minutes between battery reports, 0 (never) or 5 to 720. */
  battery: number | null;
  /** Its own message for 1 to 5 presses ("1"…"5"). */
  presses: Partial<Record<'1' | '2' | '3' | '4' | '5', string>> | null;
}

/** One position a home base heard from a tracker, and how it got home. */
export interface TrackerHeard {
  at: number;
  lat: number;
  lng: number;
  hops: number | null;
  snr: number | null;
  /** The last node that relayed it (null when heard directly), and where that node is if known. */
  relay: { id: string; name: string | null; lat: number | null; lng: number | null } | null;
  /** How it reached the home base: its radio, a gateway over the internet, a phone, or a public beacon. */
  src: 'radio' | 'internet' | 'phone' | 'beacon';
}

/** What a home base's radio knows about a node it hears. */
export interface MeshNodeRadio {
  /** When it was last heard. */
  at: number | null;
  hops: number | null;
  /** Signal-to-noise ratio when last heard, dB. */
  snr: number | null;
  /** Battery percent from its telemetry. */
  battery: number | null;
  /** On external power. */
  plugged: boolean;
  volts: number | null;
}

export interface HomeBaseStatus {
  at: number;
  /** How often it reports, in seconds; null for older home bases (every 5 minutes). */
  every: number | null;
  /** After how long a phone counts as quiet (the Meshtastic plugin's setting), or null for the default. */
  quietMinutes: number | null;
  /** The home base itself. */
  self: {
    battery: number | null;
    volts: number | null;
    plugged: boolean;
    /** Wi-Fi signal, dBm. */
    wifi: number | null;
    /** Seconds since it started. */
    up: number | null;
    /** Free memory, KB. */
    heap: number | null;
    /** LoRa channel busy, percent. */
    ch: number | null;
    /** Its own transmitting, percent of the hour. */
    tx: number | null;
    /** The internet bridge (MQTT): connected or not; null when it's off. */
    mqtt?: boolean | null;
  } | null;
  gps: { fix: boolean; sats: number | null; hdop: number | null } | null;
  /** Its firmware version, if it says (0.29.0 and later). */
  fw?: string | null;
  heard: ({ node: string; name: string | null } & MeshNodeRadio)[];
  /** Its trackers: `at` is their last position on the map; `radio` what the radio last heard from them; `settings` whether HomeCircle's settings are on the tracker. */
  trackers: {
    node: string;
    member: string;
    at: number | null;
    radio: MeshNodeRadio | null;
    settings: 'set' | 'sending' | 'needs-key' | null;
    /** Positions the home base heard lately (oldest first), each with its hops and last relay. */
    log: TrackerHeard[];
  }[];
  /** Its Meshtastic node id ("!69852494"). */
  node: string | null;
  /** Its Meshtastic public key (base64): a tracker with it as an admin key takes settings from the home base. */
  key: string | null;
  /** The link (meshtastic.org/e/#…) that puts a tracker on the circle's private channel, opened in the Meshtastic app. */
  channel: string | null;
}

/** Admin settings about one member (her skin and Elderly Companion settings, someone's he/she). */
export interface MemberRecord {
  member: string;
  /** Which skin their phone shows ('full', 'elderly', …). */
  skin: string;
  page: 'care' | 'grandkids' | null;
  ringEveryone: boolean | null;
  games: boolean | null;
  /** She can place calls herself (default on); off leaves only Call me. */
  canDial: boolean | null;
  /** Her tiles' order (member ids). */
  tiles: string[] | null;
  /** Her sleep hours, "HH:MM" her time. */
  sleep: { from: string; to: string } | null;
  remindEvery: number | null;
  inactiveHours: number | null;
  lang: string | null;
  g: Gender | null;
  /** Photos an admin added for her tiles, by member id. */
  photos: Record<string, PhotoRef> | null;
  /** Her phone number ("+15551234567"), when an admin saved one. */
  phone: string | null;
  /** How a tracker reports (a tracker phone or a small tracker device), or null. */
  tracker: TrackerSettings | null;
  /** A home base's own status, in the record about itself, or null. */
  homeBase: HomeBaseStatus | null;
  /** Who signed it (an admin) and when. */
  by: string;
  ts: number;
}

/** What one member calls another ("Nani"), and how they're related. */
export interface FamilyName {
  caller: string;
  member: string;
  name: string;
  rel: 'grandparent' | 'grandchild' | 'parent' | 'child' | 'sibling' | 'other' | null;
  by: string;
  ts: number;
}

/** Answers to a call-back request. Only 'now' closes it. */
export type CallbackReply = 'now' | '5min' | 'morning' | 'evening';
export const CALLBACK_REPLIES: CallbackReply[];
/** Every answer a request can get: the four replies, and 'asleep', which a phone sends by itself at night or on Do Not Disturb. */
export type CallbackAnswer = CallbackReply | 'asleep';
export const CALLBACK_ANSWERS: CallbackAnswer[];
/** How each answer reads in the chat ("I'm calling you now"). */
export const CALLBACK_REPLY_TEXT: Record<CallbackReply, string>;

/** What a call signal says. `callId` ties signals to one call. */
export type CallSignalBody = { callId: string; op: 'offer' | 'answer' | 'ice' | 'ringing' | 'hangup' | 'busy' | 'decline'; [k: string]: unknown };
export type CallSignal = CallSignalBody & { from: string; id: string; ts: number };

/** A chirp waiting for this device. */
export interface IncomingChirp {
  id: string;
  from: string;
  name: string;
  sound: ChirpSound;
  flash: boolean;
  at: number;
}

export type FrequentKind = 'home' | 'work' | 'school' | 'shopping' | 'grocery' | 'gas' | 'food' | 'gym' | 'health' | 'worship' | 'park' | 'other';

/** One of someone's most visited places, as they share it. */
export interface FrequentPlace {
  id: string;
  name: string;
  kind: FrequentKind;
  lat: number;
  lng: number;
  visits: number;
  /** Hours spent there over the last 30 days. */
  hours: number;
  lastAt: number | null;
}

export interface MemberLocation {
  lat: number;
  lng: number;
  /** A home base shown at the place it's pinned to, not where its GPS says. */
  pinned?: boolean;
  accuracy: number | null;
  battery: number | null;
  charging: boolean;
  speed: number | null;
  trigger: string;
  placeId: string | null;
  /** Shared on purpose as a rough area (~1 km), not an exact pin. */
  approximate: boolean;
  /** Battery saver / Low Power Mode on the phone, if reported. */
  power: 'saver' | 'normal' | null;
  /** Location permission: 'always' (background) or 'foreground' (while using), if reported. */
  perm: 'always' | 'foreground' | null;
  /** Precise location allowed, if reported. */
  precise: boolean | null;
  /** The HomeCircle app version that phone runs (0.16+; null from older apps). */
  app: string | null;
  /** How often that phone updates now (minutes), its slider stop, and whether charging or its battery budget changes it (0.18+). */
  cadence: { stop: number | 'custom'; moving: number; still: number; charging: boolean; limited: boolean } | null;
  /** Do Not Disturb (or bedtime) was on when this was sent. */
  dnd?: boolean;
  /** Their time zone, e.g. "America/Chicago". */
  tz?: string | null;
  /** An elder's phone: when she last used it. */
  used?: number | null;
  /** The skin this phone is showing ('full', 'elderly'), 0.22.1+. */
  skin?: string | null;
  /** The page it shows in the Elderly Companion skin. */
  page?: 'care' | 'grandkids' | null;
  /** 'radio': a tracker's location that came over the mesh through a home base. */
  via?: 'radio' | null;
  /** A tracker's radio path to its home base: hops, and the nodes from the tracker to the home base. */
  mesh?: MeshPath | null;
  ts: number;
  receivedAt: number;
}

/** The way a tracker's position reached its home base (a Meshtastic traceroute). */
export interface MeshPath {
  /** Relays between the tracker and the home base (0: heard directly). */
  hops: number | null;
  /** When the path was traced. */
  at: number | null;
  /** From the tracker to the home base; snr is how the next node heard each one (dB). */
  path: { id: string | null; name: string | null; snr: number | null; lat: number | null; lng: number | null }[] | null;
  /** How it reached HomeCircle: the home base's radio, a gateway over the internet (MQTT), the carrier's phone, or a public beacon. */
  src?: 'radio' | 'internet' | 'phone' | 'beacon' | null;
  /** The gateway or phone that passed it on ("Uncle's node", "Sara's phone"). */
  gateway?: string | null;
}

/** A tracker's mesh packet, opened (see mesh.js). */
export interface MeshHeader {
  type: 1 | 2 | 3;
  ref: string;
  counter: number;
  epoch: number;
  id: string | null;
  headerLen: number;
}
export const MESH_LOCATION: 1;
export const MESH_SOS_START: 2;
export const MESH_SOS_SAFE: 3;
export function meshRef(memberId: string): string;
export function meshHeader(bytes: Uint8Array): MeshHeader | null;
export function openMesh(b64: string, opts: { key: string; signPub: string; from: string; circle: string }): { v: 1; kind: 'location' | 'chat'; from: string; circle: string; epoch: number; ts: number; body: Record<string, unknown>; id?: string };

export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius: number;
  icon: string;
  /** Street address it was added from, if any. */
  address: string | null;
  /** Shared by copies of the same place in several circles. */
  group: string | null;
  /** The home base is pinned here (its spot on the map). */
  homeBase?: boolean;
  updatedBy: string;
}

export interface Message {
  seq: number;
  id: string;
  from: string;
  /** Recipient of a direct message; null for the group chat. */
  to: string | null;
  /** The other person in a direct conversation; null for the group chat. */
  peer: string | null;
  createdAt: number;
  kind: 'chat' | 'event' | 'unreadable';
  ts: number;
  body: any;
}

/** Someone's SOS that hasn't ended yet. */
export interface ActiveSos {
  id: string;
  memberId: string;
  name: string;
  since: number;
  /** The last safe place they reached during it, if any. */
  arrived: { place: string; at: number } | null;
}

export interface PollOptionInput {
  label: string;
  emoji?: string;
}

/** A poll as drawn: options with votes, who voted, closed or not, and the winners. */
export interface PollState {
  id: string;
  question: string;
  multi: boolean;
  allowAdd: boolean;
  closesAt: number | null;
  creator: string;
  creatorName: string;
  /** You started it (so you can close it). */
  mine: boolean;
  options: { id: string; label: string; emoji: string; votes: number; voters: string[]; mine: boolean; by?: string }[];
  /** How many people voted, and how many can. */
  voters: number;
  eligible: number;
  everyoneVoted: boolean;
  myVote: string[];
  closed: boolean;
  /** The option(s) with the most votes; empty before anyone votes. */
  winners: PollState['options'];
  spin: { option: PollState['options'][number]; by: string; ts: number } | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
  names: string[];
}

export interface Account {
  server: string;
  token: string;
  memberId: string;
  circleId: string;
  epoch: number;
  keyring: Record<number, string>;
  profile: { name: string; color: string };
  known: Record<string, { signPub: string; boxPub: string; name: string }>;
  identity: { boxPub: string; boxSecret: string; signPub: string; signSecret: string };
}

export interface ServerInfo {
  server: string;
  app: 'homecircle';
  version: string;
  setup: boolean;
  /** Set only when the server hosts exactly one circle. */
  circleId: string | null;
  /** Server can host several circles (0.4+). */
  multiCircle?: boolean;
  /** Setup-code recovery and rejoin requests (0.8+). */
  recovery?: boolean;
  /** Chirps and most-visited places (0.9+). */
  chirps?: boolean;
  /** Voice call signals are relayed here (0.22+). */
  calls?: boolean;
  frequentPlaces?: boolean;
  push: boolean;
  tileUrl: string;
  tileAttribution: string;
  locationRequestCooldown: number;
}

export interface Invite {
  id: string;
  expiresAt: number;
  link: string;
  appLink: string;
}

/** A circle as the setup code shows it: names are encrypted, so only these. */
export interface RecoverableCircle {
  id: string;
  createdAt: number;
  /** Members still in it (including anyone who signed out without leaving). */
  members: number;
  lastSeenAt: number | null;
  /** Rejoin requests waiting for a member. */
  waiting: number;
}

/** A rejoin request made on this device. Holds new secret keys: keep it in secure storage. */
export interface PendingRejoin {
  server: string;
  circleId: string;
  requestId: string;
  auth: string;
  identity: { boxPub: string; boxSecret: string; signPub: string; signSecret: string };
  name: string;
  expiresAt: number;
  safetyNumber: string;
}

/** Someone asking to rejoin this circle with the setup code. */
export interface RejoinRequest {
  id: string;
  name: string;
  boxPub: string;
  signPub: string;
  createdAt: number;
  expiresAt: number;
  safetyNumber: string;
}

export interface InvitePreview {
  serverUrl: string;
  inviteId: string;
  circleId?: string;
  circleName?: string;
  invitedBy?: string;
  /** Set for an Elderly Companion invite: her name, and which page this circle is on her phone. */
  companion?: CompanionInvite | null;
}

export interface CompanionInvite {
  name: string;
  page: 'care' | 'grandkids';
  /** Which skin her phone shows ('elderly' by default). */
  skin?: string;
}

/** A WhatsApp group call someone started in the circle. */
export interface GroupCallState {
  id: string;
  /** Who started it. */
  from: string;
  ts: number;
  /** Who said they joined, the starter first. */
  joined: string[];
  /** Who's still on it (a call in HomeCircle: people say when they leave). */
  present: string[];
  /** A call in HomeCircle, not on WhatsApp. */
  mesh: boolean;
  /** When it started or someone last joined. */
  last: number;
  /** Still on: under 30 minutes since `last`. */
  open: boolean;
}

/** Where a call-back request from the Elderly Companion app stands. */
export interface CallbackState {
  id: string;
  /** Who asked. */
  from: string;
  name: string;
  ts: number;
  seq: number;
  /** Who was asked; null = everyone in the circle. */
  for: string[] | null;
  /** The asker's time zone, e.g. "Asia/Karachi". */
  tz: string | null;
  /** Outside the asker's sleep hours when sent. */
  awake: boolean;
  /** Minutes between reminders on the family's phones; 0 = none. */
  remind: number;
  /** Each person's latest answer, oldest first. */
  replies: { memberId: string; name: string; reply: CallbackAnswer; ts: number; seq: number }[];
  /** The first "I'm calling you now": the request is closed. */
  takenBy: { memberId: string; name: string; ts: number } | null;
  open: boolean;
}

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'unauthorized';

export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfter?: number;
  /** Underlying network error, for diagnostics. */
  detail?: string;
}

export class Api {
  constructor(baseUrl: string, opts?: { token?: string | null; fetchImpl?: typeof fetch; binaryFetchImpl?: (url: string, init?: any) => Promise<any>; WebSocketImpl?: any });
  baseUrl: string;
  token: string | null;
  info(): Promise<Omit<ServerInfo, 'server'>>;
  putPush(token: string | null, platform: string, opts?: { fallback?: boolean }): Promise<{ ok: true }>;
  listInvites(): Promise<{ invites: { id: string; createdBy: string; createdAt: number; expiresAt: number }[] }>;
  deleteInvite(id: string): Promise<{ ok: true }>;
  /** The weather plugin, for a grid cell (lat and lng rounded to 0.1°). */
  weather(lat: number, lng: number): Promise<Weather>;
  /** The air and pollen plugin, the same way. */
  air(lat: number, lng: number): Promise<AirQuality>;
  /** The prayer times plugin: today's and tomorrow's times at a grid cell, for a madhab. */
  prayer(lat: number, lng: number, madhab: Madhab): Promise<PrayerDays>;
  registerMesh(key: string): Promise<{ ok: true; ref: string }>;
  pluginSettings(id: string): Promise<PluginSettings>;
  putPluginSettings(id: string, values: Record<string, string>): Promise<{ ok: true; values: PluginSettings['values']; ready: boolean }>;
  homeAssistantLocation(body: { lat: number; lng: number; accuracy?: number | null; battery?: number | null; charging?: boolean | null; speed?: number | null; name: string }): Promise<{ ok: true; entity: string }>;
  [key: string]: any;
}

/** What the weather plugin answers. Temperatures in °C. */
export type Weather = {
  cell: { lat: number; lng: number };
  at: string | null;
  timezone: string | null;
  now: { temp: number | null; feels: number | null; code: number | null; day: boolean };
  today: { high: number | null; low: number | null; rain: number | null };
  hours: { time: string; temp: number | null; rain: number | null; code: number | null; day: boolean }[];
  units: 'C';
  source: string;
};

/** What the air and pollen plugin answers. Pollen levels: 0 none … 5 very high. */
export type AirQuality = {
  cell: { lat: number; lng: number };
  at: string | null;
  aqi: { us: number | null; eu: number | null; category: string | null; pm25: number | null; pm10: number | null; ozone: number | null };
  hours: { time: string; aqi: number | null }[];
  pollen: { source: 'Open-Meteo' | 'Google'; types: { id: 'tree' | 'grass' | 'weed'; label: string; level: number | null; category: string | null }[] } | null;
  source: string;
};

/** A madhab: it sets Asr's shadow length, and Shia (Ja'fari) has its own method. */
export type Madhab = 'shafi' | 'hanafi' | 'maliki' | 'hanbali' | 'shia';
export const MADHABS: { id: Madhab; label: string }[];
export const DEFAULT_MADHAB: Madhab;
export type PrayerId = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';
/** One day's times as instants (ms since 1970); null where the sun doesn't get there. */
export type PrayerTimes = Record<PrayerId | 'sunrise' | 'sunset' | 'midnight', number | null>;
export const PRAYERS: { id: PrayerId; name: string; until: 'sunrise' | 'asr' | 'sunset' | 'isha' | 'midnight' }[];
export const METHODS: Record<string, { name: string; fajr: number; isha?: number; ishaMinutes?: number; maghrib?: number; maghribMinutes?: number; shia?: boolean }>;
export function methodFor(timezone: string | null | undefined, madhab?: Madhab): string;
export function prayerTimes(opts: { lat: number; lng: number; date: string; madhab?: Madhab; method?: string }): PrayerTimes;
/** What the prayer times plugin answers: today and tomorrow where the cell is, with that day's UTC offset in minutes. */
export type PrayerDays = {
  cell: { lat: number; lng: number };
  timezone: string | null;
  /** No time zone was found: times are shown by the sun's (longitude ÷ 15). */
  roughZone: boolean;
  madhab: Madhab;
  method: { id: string; name: string };
  days: { date: string; offset: number; times: PrayerTimes }[];
  source: string;
};
export type PrayerSlot = { id: PrayerId; name: string; until: string; date: string; start: number; end: number | null };
/** The prayer whose window is open at `now` (or null), and the next one to start. */
export function prayerNow(days: { date: string; times: PrayerTimes }[], now?: number): { current: PrayerSlot | null; next: PrayerSlot | null };

/** A plugin's settings, as an admin sees them. */
export type PluginField = { id: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string; help?: string; numeric?: boolean; /** Shown on a screen of its own, not in the plugin's form ("trackers": Meshtastic tracker settings). */ section?: string };
export type PluginSettings = {
  fields: PluginField[];
  values: Record<string, string | { set: boolean }>;
  ready: boolean;
  suggested: Record<string, string>;
};

/** Which circle a chat push is about: a short hash of the receiving member's id (only that phone can match it). */
export function pushHint(memberId: string): string;

export const ACCOUNT_KEY: string;

/** Why a device's keys were deleted, as passed with the 'signedOut' event. */
export type SignOutReason = 'signed_out' | 'left' | 'deleted_circle' | 'removed' | 'circle_deleted' | 'unrecognized';

export class CircleClient {
  /** `cache`: where opened messages are kept between launches (one entry per circle; can be a few MB). */
  constructor(opts: { storage: Storage; cache?: Storage; accountKey?: string; fetchImpl?: typeof fetch; binaryFetchImpl?: (url: string, init?: any) => Promise<any>; WebSocketImpl?: any; onError?: (e: Error) => void });
  /** Where this circle's account is stored. */
  readonly accountKey: string;
  static serverInfo(serverUrl: string, fetchImpl?: typeof fetch): Promise<ServerInfo>;
  static setupTicket(serverUrl: string, setupToken: string, fetchImpl?: typeof fetch): Promise<{ code: string; expiresAt: number }>;
  /** A browser asks to be signed in from a phone; show `url` as a QR code. */
  static startLink(serverUrl: string, label: string, fetchImpl?: typeof fetch): Promise<BrowserLinkStart>;
  /** The browser: wait for the phone's answer; true once signed in. */
  finishLink(link: BrowserLinkStart, opts?: { signal?: AbortSignal; every?: number }): Promise<boolean>;
  /** The phone: sign in the browser showing this QR code as me. */
  linkBrowser(link: BrowserLink): Promise<{ ok: true; session: { id: string; label: string } }>;
  browserSessions(): Promise<BrowserSession[]>;
  signOutBrowser(id: string): Promise<void>;
  readonly isLinkedBrowser: boolean;
  /** With the server's setup code: every circle on it. */
  static recoverCircles(serverUrl: string, setupToken: string, fetchImpl?: typeof fetch): Promise<{ server: string; circles: RecoverableCircle[] }>;
  /** With the server's setup code: delete a circle for everyone in it. */
  static recoverDeleteCircle(serverUrl: string, setupToken: string, circleId: string, fetchImpl?: typeof fetch): Promise<void>;
  /** With the server's setup code: ask a circle's members to let you back in as its owner. */
  static requestRejoin(opts: { serverUrl: string; setupToken: string; circleId: string; name: string; fetchImpl?: typeof fetch }): Promise<PendingRejoin>;

  account: Account | null;
  api: Api;
  circle: { name: string; agent?: { name: string; id?: string } | null; groupCallLink?: string | null };
  members: Map<string, Member>;
  locations: Map<string, MemberLocation>;
  /** Members who paused sharing with this circle: since when, and their optional reason. */
  paused: Map<string, { since: number; reason: string | null }>;
  messages: Message[];
  /** Highest message sequence number received. */
  lastSeq: number;
  places: Map<string, Place>;
  status: ConnectionStatus;
  readonly me: Member | null | undefined;
  readonly isAdmin: boolean;
  /** Your name, even before the member list has loaded. */
  readonly myName: string;
  /** The circle's agent once it has joined, or null. */
  readonly agent: { id: string; name: string } | null;
  /** The agent's name while it's invited but hasn't joined, or null. */
  readonly agentInvited: { name: string } | null;
  readonly serverUrl: string | undefined;
  readonly circleId: string | null;
  /** Can create more circles on this server. */
  readonly isServerAdmin: boolean;

  on(event: 'members', fn: (m: Member[]) => void): () => void;
  on(event: 'locations', fn: (l: Map<string, MemberLocation>) => void): () => void;
  on(event: 'messages', fn: (m: Message[]) => void): () => void;
  on(event: 'newMessage', fn: (m: Message) => void): () => void;
  on(event: 'places', fn: (p: Map<string, Place>) => void): () => void;
  on(event: 'status', fn: (s: ConnectionStatus) => void): () => void;
  on(event: 'locationRequest', fn: (r: { from: string }) => void): () => void;
  on(event: 'rejoinRequests', fn: () => void): () => void;
  /** The server says it doesn't know this device. Keys are kept: the app decides whether to sign out. */
  on(event: 'unrecognized', fn: () => void): () => void;
  /** Someone chirped this device: collect with collectChirps(). */
  on(event: 'chirp', fn: () => void): () => void;
  /** A call signal from a member (opened, verified and fresh); see sendCallSignal(). */
  on(event: 'callSignal', fn: (s: CallSignal) => void): () => void;
  on(event: 'busy', fn: (b: Map<string, { blocks: BusyBlock[]; ts: number }>) => void): () => void;
  on(event: 'frequent', fn: (f: Map<string, { places: FrequentPlace[]; ts: number }>) => void): () => void;
  on(event: 'signedOut', fn: (d: { reason: SignOutReason }) => void): () => void;
  on(event: 'circle' | 'removed', fn: (d?: any) => void): () => void;
  on(event: string, fn: (d?: any) => void): () => void;

  load(): Promise<boolean>;
  changeServer(serverUrl: string): Promise<ServerInfo>;
  /** Check an address reaches the server holding this circle, without switching. */
  verifyServer(serverUrl: string): Promise<ServerInfo>;
  /** Forget this device's keys. The reason goes with the 'signedOut' event (default 'signed_out'). */
  signOut(reason?: SignOutReason): Promise<void>;
  /** With the server's setup code (any time), or `admin`: a client already on that server that can create circles. */
  createCircle(opts: { serverUrl: string; setupToken?: string; admin?: CircleClient; name: string; circleName: string; features?: Features }): Promise<void>;
  previewInvite(link: string): Promise<InvitePreview>;
  /** Join with an invite link; an Elderly Companion invite already carries her name. */
  joinWithInvite(link: string, opts?: { name?: string }): Promise<void>;
  /** Join once a member approved the request: 'joined'. Otherwise its status. */
  finishRejoin(pending: PendingRejoin): Promise<'joined' | 'pending' | 'denied' | 'expired'>;
  rejoinRequests(): Promise<RejoinRequest[]>;
  approveRejoin(request: RejoinRequest): Promise<void>;
  denyRejoin(id: string): Promise<unknown>;
  refresh(): Promise<unknown>;
  memberList(): Member[];
  /** The most text (UTF-8 bytes) one mesh message carries. */
  readonly meshTextMax: { chat: number; direct: number };
  /** Whether this text fits one mesh message (a direct one if `to`). */
  meshFits(text: string, to?: string | null): boolean;
  /** Whether this phone's mesh key is registered, so it can send over the mesh. */
  readonly meshReady: boolean;
  /** Register this member's mesh key with the server (needs the internet once). */
  prepareMesh(): Promise<void>;
  /** A message sealed for the mesh (one LoRa packet), for the tracker to send. */
  meshMessage(text: string, opts?: { to?: string | null; id?: string }): Promise<{ id: string; packet: Uint8Array }>;
  /** A tracker or a Meshtastic home base rather than a person (from the admin's record about it). */
  hiddenDevice(memberId: string): boolean;
  isDevice(memberId: string): boolean;
  /** Members who are people: not trackers or a home base. */
  peopleList(): Member[];
  /** Trackers and home bases. */
  deviceList(): Member[];
  fetchLocations(): Promise<Map<string, MemberLocation>>;
  shareLocation(loc: {
    lat: number;
    lng: number;
    accuracy?: number | null;
    battery?: number | null;
    charging?: boolean;
    speed?: number | null;
    trigger?: string;
    placeId?: string | null;
    /** Already rounded with approximate(); marks it as a rough area. */
    approx?: boolean;
    power?: 'saver' | 'normal';
    perm?: 'always' | 'foreground';
    precise?: boolean;
    /** This phone's HomeCircle app version (shown in Circle health). */
    app?: string;
    /** How often this phone updates now, in minutes (shown under its name). */
    cadence?: { stop: number | 'custom'; moving: number; still: number; charging: boolean; limited: boolean };
    ts?: number;
    /** Do Not Disturb (or bedtime) is on now. */
    dnd?: boolean;
    /** This phone's time zone. */
    tz?: string | null;
    /** An elder's phone: when she last used it. */
    used?: number | null;
    /** The skin and page this phone is showing now. */
    skin?: string;
    page?: 'care' | 'grandkids' | null;
  }): Promise<void>;
  /** Remove this device's location from the circle (stop sharing with it). */
  clearLocation(): Promise<void>;
  /** `delivery` per person: 'delivered' (live connection), 'pushed', or 'unreachable' (servers 0.7+). */
  requestLocations(targets?: string[]): Promise<{
    requested: number;
    online: number;
    pushed: number;
    delivery?: Record<string, 'delivered' | 'pushed' | 'unreachable'>;
    cooldown: number;
  }>;
  /** The messages this phone doesn't have yet, newest first (see backfillHistory for the older ones). */
  fetchMessages(): Promise<Message[]>;
  /** Whether older history exists on the server that this phone hasn't fetched yet. */
  readonly hasOlder: boolean;
  /** Fetch one more page of older messages (the person scrolled up). Resolves to how many arrived. */
  loadOlder(limit?: number): Promise<number>;
  /** Read the rest of the history in behind the screen, a page at a time (starts by itself after start()). */
  backfillHistory(): Promise<void>;
  /** Read this phone's saved copy (messages, members, last locations) without waiting for the network; once. */
  loadCache(): Promise<void>;
  /** Save the phone's copy now if anything changed, e.g. as the app goes to the background. */
  flushCache(): Promise<void>;
  /** How long the pieces of opening took, for Diagnostics. */
  timings: {
    cache?: { ms: number; rows: number; fetchedSeq: number };
    refreshMs?: number;
    firstFetch?: { mode: 'tail' | 'forward' | 'gap'; count: number; ms: number };
  };
  /** Group chat, or a direct message when `to` is set. */
  /** Pass the same `id` to try a message again: the server keeps one copy, and one it already has counts as sent. */
  sendChat(text: string, opts?: { to?: string | null; id?: string }): Promise<void>;
  /** Messages of the group (peer null) or of a direct chat. */
  conversation(peer?: string | null): Message[];
  /** People you have direct conversations with, most recent first. */
  directPeers(): string[];
  /** How long this circle keeps messages (days) and the allowed choices. */
  readonly retention: { days: number | null; choices: number[] };
  /** Admins: change how long messages are kept. */
  setRetention(days: number): Promise<void>;
  /** The circle's features: which are on. */
  readonly features: Features;
  /** Whether a feature works in this circle (on, and so is whatever it needs). */
  feature(id: FeatureId): boolean;
  /** Admins: turn features on or off. */
  setFeatures(features: Partial<Features>): Promise<void>;
  /** Stop sharing with this circle; it sees that you paused. */
  pauseSharing(reason?: string): Promise<void>;
  /** Pass a stable id to retry safely; a repeat the server already has counts as delivered. */
  sendEvent(body: Record<string, unknown>, opts?: { id?: string }): Promise<void>;
  /** "Where are you?": a direct message with a one-tap answer, plus a fresh location request. */
  askToCheckIn(peer: string): Promise<void>;
  /** Admins: a direct message asking someone to fix their setup. */
  nudgeSetup(peer: string, problem?: string): Promise<void>;
  /** Answer a check-in with "I'm OK". */
  checkIn(peer: string): Promise<void>;
  /** Add or remove this person's reaction. Doesn't trigger a notification. */
  react(messageId: string, emoji: string): Promise<void>;
  reactionsFor(messageId: string): Reaction[];
  /** Start a poll (2–8 options) in the group chat, or a direct chat with `to`. */
  createPoll(
    poll: { question: string; options: PollOptionInput[]; multi?: boolean; allowAdd?: boolean; closesAt?: number | null },
    opts?: { to?: string | null },
  ): Promise<void>;
  vote(pollId: string, optionIds: string[]): Promise<void>;
  suggestOption(pollId: string, label: string, emoji?: string): Promise<void>;
  /** Its creator only: close it and post the result. */
  closePoll(pollId: string): Promise<void>;
  /** Pick one of the leading options (or any) at random and tell everyone. */
  spinWheel(pollId: string): Promise<PollState['options'][number]>;
  pollState(pollId: string, now?: number): PollState | null;
  /** Send an SOS to the whole circle; returns its id. */
  startSos(): Promise<string>;
  /** Tell the circle you reached a safe place during your SOS. */
  sosArrived(sosId: string, placeName: string): Promise<void>;
  /** End your SOS ("I'm safe"). */
  endSos(sosId: string): Promise<void>;
  /** SOSes still on, newest first. */
  activeSos(now?: number): ActiveSos[];
  /** Ask for a call back: everyone (`to` null) or one member. Returns the request's id. */
  askCallback(opts?: { to?: string | null; tz?: string | null; awake?: boolean; remind?: number }): Promise<string>;
  /** Answer a call-back request; 'now' closes it. */
  replyCallback(requestId: string, reply: CallbackAnswer): Promise<void>;
  /** Whether a member is likely asleep: Do Not Disturb (in the last 12 hours) or night where they are. */
  availability(memberId: string, now?: number): { asleep: boolean; dnd: boolean; night: boolean; tz: string | null };
  /** Elders whose phone hasn't been used for longer than their admins set. */
  inactiveElders(now?: number): { memberId: string; name: string; hours: number; used: number }[];
  /** Where a request stands, or null if it isn't one (or its sender left). */
  callbackState(requestId: string): CallbackState | null;
  /** Whether a request asks this member (default: you). */
  callbackAsks(state: CallbackState | null, memberId?: string): boolean;
  /** Open requests in this circle, newest first. */
  openCallbacks(opts?: { from?: string | null }): CallbackState[];
  /** Open requests that ask you, have reminders on, and you haven't answered. */
  callbacksAwaitingMe(): CallbackState[];
  /** Member settings and family names as last fetched. */
  records: { member: Map<string, MemberRecord>; alias: Map<string, FamilyName> };
  /** Fetch and check the circle's sealed records (emits 'records'). */
  fetchRecords(): Promise<{ member: Map<string, MemberRecord>; alias: Map<string, FamilyName> }>;
  /** Admin settings about a member, or null. */
  memberRecord(memberId: string): MemberRecord | null;
  /** Admins: change settings about a member (merged into what's there). */
  setMemberRecord(memberId: string, patch: Partial<Omit<MemberRecord, 'member' | 'by' | 'ts'>>): Promise<MemberRecord | null>;
  /** Admins: mark someone as an elder (their phone switches skin; they stop being an admin). */
  markElder(memberId: string, settings?: Partial<Omit<MemberRecord, 'member' | 'by' | 'ts'>>): Promise<MemberRecord | null>;
  /** What `callerId` calls `memberId`, or null. */
  familyName(callerId: string, memberId: string): string | null;
  /** How to name a member to a viewer (you by default). */
  displayName(memberId: string, viewerId?: string): string;
  /** Set what `callerId` calls `memberId` (empty name removes it). */
  setFamilyName(callerId: string, memberId: string, opts: { name: string; rel?: FamilyName['rel'] }): Promise<string | null>;
  /** A member's he/she: their own choice, else an admin's, else null. */
  genderOf(memberId: string): Gender | null;
  /** Set your own photo (JPEG bytes), or remove it (null). */
  setProfilePhoto(bytes: Uint8Array | null): Promise<void>;
  /** Admins: set (or remove, null) the photo on an elder's tile for someone. */
  setTilePhoto(elderId: string, memberId: string, bytes: Uint8Array | null): Promise<void>;
  /** The photo an elder's tile shows for someone: their own, else an admin's, else null. */
  tilePhoto(elderId: string, memberId: string): PhotoRef | null;
  /** A photo's bytes. */
  photoBytes(ref: PhotoRef): Promise<Uint8Array>;
  /** Your own he/she in your profile (null clears it). */
  setGender(g: Gender | null): Promise<void>;
  /** Your own phone number, sealed in your profile (empty clears it; throws without a country code). */
  setPhone(phone: string | null): Promise<void>;
  /** A member's phone number: their own, else an admin's, else null. */
  phoneOf(memberId: string): string | null;
  /** The circle's WhatsApp call link, or null. */
  readonly groupCallLink: string | null;
  /** Admins: save (empty removes) the circle's WhatsApp call link, sealed in the circle's record. */
  setGroupCallLink(link: string | null): Promise<void>;
  /** Start the circle's group call (everyone is told), or join the one that's on. Returns its id. */
  startGroupCall(): Promise<string>;
  /** Say you joined a group call (once per call). */
  joinGroupCall(callId: string): Promise<void>;
  groupCallState(callId: string, now?: number): GroupCallState | null;
  startMeshCall(): Promise<string>;
  leaveGroupCall(callId: string): Promise<void>;
  /** The group call that's on now, or null. */
  activeGroupCall(now?: number): GroupCallState | null;
  /** An elder's phone, once joined: tell the circle, so an admin's phone saves her settings. */
  announceElder(opts?: { page?: 'care' | 'grandkids'; skin?: string }): Promise<void>;
  /** Elders who announced themselves and have no member record yet. */
  unrecordedElders(): { memberId: string; page: 'care' | 'grandkids'; skin: string }[];
  /** Tell the others you've read a conversation (peer null = the group) up to `seq`. */
  sendReadReceipt(peer: string | null, seq: number): Promise<void>;
  /** For your own message: 'sent', 'delivered' (every recipient's phone has it) or 'read'. */
  receipt(m: Message): 'sent' | 'delivered' | 'read';
  /** Who has read, has, or hasn't got your message yet (names). */
  receiptsFor(m: Message): { read: string[]; delivered: string[]; waiting: string[] };
  /** Whether this server can run an agent, and whether this circle's is running. */
  agentHostStatus(): Promise<{ available: boolean; running: boolean }>;
  /** Admins: add the circle's agent, run by this server, named `name`. */
  setUpAgent(opts: { name: string }): Promise<{ id: string; name: string } | null>;
  /** Admins: an agent invite link (for an agent run somewhere else). */
  createAgentInvite(opts: { name: string; hours?: number }): Promise<{ id: string; expiresAt: number; link: string }>;
  setAgentName(name: string): Promise<void>;
  removeAgent(): Promise<void>;
  /** Ask the agent, in the group (peer null) or in a direct chat with it (peer = its id). */
  askAgent(text: string, opts?: { peer?: string | null }): Promise<string | null>;
  /** Send the agent just this one message to remember. */
  rememberWithAgent(messageId: string): Promise<void>;
  /** Undo what the agent just remembered. */
  undoAgent(noteIds: string[], opts?: { peer?: string | null }): Promise<void>;
  shareAgentNotes(noteIds: string[], opts?: { peer?: string | null }): Promise<void>;
  /** Send the agent a photo, PDF, document or spreadsheet, encrypted for it. Returns the visible message's id. */
  sendFileToAgent(bytes: Uint8Array, file: { name: string; mime: string }, opts?: { peer?: string | null }): Promise<string>;
  /** After a file was read and saved: delete it from the server, or keep it. */
  answerAgentFile(choiceId: string, keep: boolean, opts?: { peer?: string | null }): Promise<void>;
  /** Done on a reminder the helper sent (a yearly one moves to next year). */
  doneAgentReminder(reminderId: string, opts?: { peer?: string | null }): Promise<void>;
  /** A kept file's bytes ({ id, key } from its note in Memory). */
  openAgentFile(file: { id: string; key: string }): Promise<Uint8Array>;
  /** Save (ok) or Discard a list the agent found, such as the dates in a calendar PDF. */
  saveAgentFound(id: string, ok: boolean, opts?: { peer?: string | null }): Promise<void>;
  /** A request the app makes of the agent (Memory screen, settings), sealed for it; resolves with its answer. */
  agentRpc<T = any>(op: string, args?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  fetchPlaces(): Promise<Map<string, Place>>;
  savePlace(p: { id?: string; name: string; lat: number; lng: number; radius?: number; icon?: string; address?: string | null; group?: string | null; homeBase?: boolean }): Promise<string>;
  deletePlace(id: string): Promise<void>;
  /** The place the home base is pinned to, if one is chosen. */
  homeBasePlace(): Place | null;
  /** Pin the home base to a place (null: back to its GPS). */
  pinHomeBase(placeId: string | null): Promise<void>;
  createInvite(opts?: { hours?: number; companion?: CompanionInvite | null }): Promise<Invite>;
  setName(name: string): Promise<void>;
  setCircleName(name: string): Promise<void>;
  setChirp(sound: ChirpSound): Promise<void>;
  /** Chirp one member, or everyone else (to = null). Three in a row, then 30 minutes off. */
  chirp(to?: string | null, opts?: { flash?: boolean }): Promise<{ sent: number; remaining: number; cooldownUntil: number | null }>;
  collectChirps(): Promise<IncomingChirp[]>;
  /** Send a sealed call signal to a member; `ring` (the first offer) also pushes their phone. */
  sendCallSignal(to: string, body: CallSignalBody, opts?: { ring?: boolean }): Promise<{ online: boolean; held: boolean; pushed: boolean }>;
  /** Leave "Missed voice call" or "Voice call · 3:12" in the direct chat with someone. */
  logCall(to: string, opts?: { missed?: boolean; seconds?: number }): Promise<unknown>;
  /** STUN (and optional TURN) servers for a call. */
  callsConfig(): Promise<{ iceServers: { urls: string | string[]; username?: string; credential?: string }[]; relayOnly?: boolean }>;
  /** Handle call signals that waited for this phone; returns how many were new. */
  collectCallSignals(): Promise<number>;
  /** memberId -> their shared most visited places. */
  frequent: Map<string, { places: FrequentPlace[]; ts: number }>;
  fetchFrequent(): Promise<Map<string, { places: FrequentPlace[]; ts: number }>>;
  /** memberId -> when they're busy (times only). */
  busy: Map<string, { blocks: BusyBlock[]; ts: number }>;
  shareBusy(blocks: BusyBlock[]): Promise<void>;
  clearBusy(): Promise<void>;
  fetchBusy(): Promise<Map<string, { blocks: BusyBlock[]; ts: number }>>;
  createPlan(details: { title: string; start: number; end?: number; allDay?: boolean; where?: string }): Promise<string>;
  answerPlan(planId: string, rsvp: PlanAnswer): Promise<void>;
  cancelPlan(planId: string): Promise<void>;
  planState(planId: string): PlanState | null;
  shareFrequent(places: FrequentPlace[]): Promise<void>;
  clearFrequent(): Promise<void>;
  removeMember(id: string): Promise<void>;
  setRole(id: string, role: 'admin' | 'member'): Promise<void>;
  leave(): Promise<void>;
  /** Owner only: delete the circle for everyone. */
  deleteCircle(): Promise<void>;
  rotateKey(): Promise<void>;
  start(): Promise<void>;
  connect(): void;
  /** Fetch whatever changed while the live connection was down. */
  catchUp(): Promise<void>;
  disconnect(): void;
}

export const MEMBER_COLORS: string[];
/** Random URL-safe id (base64url of `bytes` random bytes). */
export function randomId(bytes?: number): string;
export function normalizeServerUrl(input: string): string;
export function parseInviteLink(link: string): { serverUrl: string; inviteId: string; secret: string };
/** A browser's sign-in QR code, read. */
export interface BrowserLink {
  server: string;
  id: string;
  boxPub: string;
  label: string;
}
export interface BrowserLinkStart extends BrowserLink {
  expiresAt: number;
  boxSecret: string;
  url: string;
}
/** A browser signed in as me, from my phone. */
export interface BrowserSession {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  current: boolean;
}
export function browserLinkUrl(serverUrl: string, linkId: string, boxPub: string, label?: string): string;
export function parseBrowserLink(text: string): BrowserLink | null;
export function openFromKey(sealed: { nonce: string; ct: string }, theirBoxPub: string, myBoxSecret: string): any;
export function newBoxKeyPair(): { boxPub: string; boxSecret: string };
export function safetyNumber(signPub: string, boxPub: string): string;

export const QUICK_REACTIONS: string[];
export const EMOJI_GROUPS: { name: string; emojis: string[] }[];
export function isEmojiOnly(text: string, max?: number): boolean;
export function isValidReaction(emoji: string): boolean;

export type BusyBlock = { s: number; e: number };
export type PlanAnswer = 'going' | 'maybe' | 'no';
export type PlanState = { id: string; title: string; start: number; end: number; allDay: boolean; where: string; from: string; cancelled: boolean; answers: { memberId: string; answer: PlanAnswer }[]; mine: PlanAnswer | null };
export type TravelRoute = { memberId: string; from: string; to: string; n: number; mins: number; low: number; high: number; leaves: number; arrives: number; days: 'weekdays' | 'all'; trend: number };
export const BUSY_DAYS: number;
export function cleanBusy(blocks: unknown): BusyBlock[];
export function busyNow(blocks: BusyBlock[], now?: number): { busy: boolean; until: number | null };
export function busyDays(blocks: BusyBlock[], enough?: number): string[];
export function tripsFrom(messages: Message[]): { memberId: string; from: string; to: string; left: number; arrived: number }[];
export function travelStats(trips: { memberId: string; from: string; to: string; left: number; arrived: number }[], opts?: { atLeast?: number; now?: number }): TravelRoute[];
export const QUICK_RETURN_MS: number;
/** Ids of "left" and "arrived" messages that cancel out: back within QUICK_RETURN_MS. */
export function quickReturns(messages: { id: string; kind: string; from: string; ts: number; body?: any }[], withinMs?: number): Set<string>;
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number;
/** 'inside' | 'outside' | null (too close to the edge or too imprecise to tell). */
export function placeState(p: { distance: number; accuracy?: number | null; radius: number }): 'inside' | 'outside' | null;
/** Round to a ~1 km grid for approximate sharing. */
export function approximate(p: { lat: number; lng: number }): { lat: number; lng: number; accuracy: number };

/** URL-safe base64 helpers and UTF-8 codecs that work in every JS engine. */
export function toB64(bytes: Uint8Array): string;
export function fromB64(str: string): Uint8Array;
export function utf8Encode(str: string): Uint8Array;
export function utf8Decode(bytes: Uint8Array): string;

/** Every feature a circle can turn on or off. */
export type FeatureId =
  | 'locationSharing'
  | 'plans'
  | 'busyTimes'
  | 'locate'
  | 'placeAlerts'
  | 'checkIns'
  | 'frequentPlaces'
  | 'lowBattery'
  | 'groupChat'
  | 'directMessages'
  | 'polls'
  | 'calls'
  | 'readReceipts'
  | 'photos'
  | 'chirps'
  | 'sos'
  | 'circleHealth'
  | 'agent'
  | 'shoppingLists'
  | 'reminders'
  | 'uploads'
  | 'weather'
  | 'air'
  | 'prayer'
  | 'whatsapp'
  | 'homeAssistant'
  | 'meshtastic';
export type Features = Record<FeatureId, boolean>;
export type FeatureInfo = { id: FeatureId; group: 'Location' | 'Chat' | 'Alerts' | 'Helper' | 'Plugins'; label: string; detail: string; on: boolean; needs?: FeatureId };
export const FEATURES: FeatureInfo[];
export const FEATURE_GROUPS: FeatureInfo['group'][];
export function defaultFeatures(): Features;
export function allFeatures(): Features;
export function cleanFeatures(input: unknown): Partial<Features>;
export function resolveFeatures(stored: unknown): Features;
export function hasFeature(features: Partial<Features> | null | undefined, id: FeatureId): boolean;
