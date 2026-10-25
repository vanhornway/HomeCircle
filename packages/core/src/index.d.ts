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
}

export type ChirpSound = 'robin' | 'wren' | 'finch' | 'chickadee' | 'cardinal' | 'bluebird' | 'canary' | 'sparrow' | 'lark' | 'dove';
export const CHIRP_SOUNDS: ChirpSound[];

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
  ts: number;
  receivedAt: number;
}

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
  putPush(token: string | null, platform: string): Promise<{ ok: true }>;
  listInvites(): Promise<{ invites: { id: string; createdBy: string; createdAt: number; expiresAt: number }[] }>;
  deleteInvite(id: string): Promise<{ ok: true }>;
  /** The weather plugin, for a grid cell (lat and lng rounded to 0.1°). */
  weather(lat: number, lng: number): Promise<Weather>;
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

export const ACCOUNT_KEY: string;

/** Why a device's keys were deleted, as passed with the 'signedOut' event. */
export type SignOutReason = 'signed_out' | 'left' | 'deleted_circle' | 'removed' | 'circle_deleted' | 'unrecognized';

export class CircleClient {
  constructor(opts: { storage: Storage; accountKey?: string; fetchImpl?: typeof fetch; binaryFetchImpl?: (url: string, init?: any) => Promise<any>; WebSocketImpl?: any; onError?: (e: Error) => void });
  /** Where this circle's account is stored. */
  readonly accountKey: string;
  static serverInfo(serverUrl: string, fetchImpl?: typeof fetch): Promise<ServerInfo>;
  /** With the server's setup code: every circle on it. */
  static recoverCircles(serverUrl: string, setupToken: string, fetchImpl?: typeof fetch): Promise<{ server: string; circles: RecoverableCircle[] }>;
  /** With the server's setup code: delete a circle for everyone in it. */
  static recoverDeleteCircle(serverUrl: string, setupToken: string, circleId: string, fetchImpl?: typeof fetch): Promise<void>;
  /** With the server's setup code: ask a circle's members to let you back in as its owner. */
  static requestRejoin(opts: { serverUrl: string; setupToken: string; circleId: string; name: string; fetchImpl?: typeof fetch }): Promise<PendingRejoin>;

  account: Account | null;
  api: Api;
  circle: { name: string };
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
  joinWithInvite(link: string, opts: { name: string }): Promise<void>;
  /** Join once a member approved the request: 'joined'. Otherwise its status. */
  finishRejoin(pending: PendingRejoin): Promise<'joined' | 'pending' | 'denied' | 'expired'>;
  rejoinRequests(): Promise<RejoinRequest[]>;
  approveRejoin(request: RejoinRequest): Promise<void>;
  denyRejoin(id: string): Promise<unknown>;
  refresh(): Promise<unknown>;
  memberList(): Member[];
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
    ts?: number;
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
  fetchMessages(): Promise<Message[]>;
  /** Group chat, or a direct message when `to` is set. */
  sendChat(text: string, opts?: { to?: string | null }): Promise<void>;
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
  savePlace(p: { id?: string; name: string; lat: number; lng: number; radius?: number; icon?: string; address?: string | null; group?: string | null }): Promise<string>;
  deletePlace(id: string): Promise<void>;
  createInvite(opts?: { hours?: number }): Promise<Invite>;
  setName(name: string): Promise<void>;
  setCircleName(name: string): Promise<void>;
  setChirp(sound: ChirpSound): Promise<void>;
  /** Chirp one member, or everyone else (to = null). Three in a row, then 30 minutes off. */
  chirp(to?: string | null, opts?: { flash?: boolean }): Promise<{ sent: number; remaining: number; cooldownUntil: number | null }>;
  collectChirps(): Promise<IncomingChirp[]>;
  /** memberId -> their shared most visited places. */
  frequent: Map<string, { places: FrequentPlace[]; ts: number }>;
  fetchFrequent(): Promise<Map<string, { places: FrequentPlace[]; ts: number }>>;
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
export function safetyNumber(signPub: string, boxPub: string): string;

export const QUICK_REACTIONS: string[];
export const EMOJI_GROUPS: { name: string; emojis: string[] }[];
export function isEmojiOnly(text: string, max?: number): boolean;
export function isValidReaction(emoji: string): boolean;

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
  | 'locate'
  | 'placeAlerts'
  | 'checkIns'
  | 'frequentPlaces'
  | 'lowBattery'
  | 'groupChat'
  | 'directMessages'
  | 'polls'
  | 'readReceipts'
  | 'chirps'
  | 'sos'
  | 'circleHealth'
  | 'agent'
  | 'shoppingLists'
  | 'reminders'
  | 'uploads'
  | 'weather';
export type Features = Record<FeatureId, boolean>;
export type FeatureInfo = { id: FeatureId; group: 'Location' | 'Chat' | 'Alerts' | 'Helper' | 'Plugins'; label: string; detail: string; on: boolean; needs?: FeatureId };
export const FEATURES: FeatureInfo[];
export const FEATURE_GROUPS: FeatureInfo['group'][];
export function defaultFeatures(): Features;
export function allFeatures(): Features;
export function cleanFeatures(input: unknown): Partial<Features>;
export function resolveFeatures(stored: unknown): Features;
export function hasFeature(features: Partial<Features> | null | undefined, id: FeatureId): boolean;
