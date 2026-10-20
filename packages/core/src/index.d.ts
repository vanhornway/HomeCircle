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
  constructor(baseUrl: string, opts?: { token?: string | null; fetchImpl?: typeof fetch; WebSocketImpl?: any });
  baseUrl: string;
  token: string | null;
  info(): Promise<Omit<ServerInfo, 'server'>>;
  putPush(token: string | null, platform: string): Promise<{ ok: true }>;
  listInvites(): Promise<{ invites: { id: string; createdBy: string; createdAt: number; expiresAt: number }[] }>;
  deleteInvite(id: string): Promise<{ ok: true }>;
  [key: string]: any;
}

export const ACCOUNT_KEY: string;

export class CircleClient {
  constructor(opts: { storage: Storage; accountKey?: string; fetchImpl?: typeof fetch; WebSocketImpl?: any; onError?: (e: Error) => void });
  /** Where this circle's account is stored. */
  readonly accountKey: string;
  static serverInfo(serverUrl: string, fetchImpl?: typeof fetch): Promise<ServerInfo>;

  account: Account | null;
  api: Api;
  circle: { name: string };
  members: Map<string, Member>;
  locations: Map<string, MemberLocation>;
  /** Members who paused sharing with this circle, and since when. */
  paused: Map<string, number>;
  messages: Message[];
  /** Highest message sequence number received. */
  lastSeq: number;
  places: Map<string, Place>;
  status: ConnectionStatus;
  readonly me: Member | null | undefined;
  readonly isAdmin: boolean;
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
  on(event: 'circle' | 'removed' | 'signedOut', fn: (d?: any) => void): () => void;
  on(event: string, fn: (d?: any) => void): () => void;

  load(): Promise<boolean>;
  changeServer(serverUrl: string): Promise<ServerInfo>;
  /** Check an address reaches the server holding this circle, without switching. */
  verifyServer(serverUrl: string): Promise<ServerInfo>;
  signOut(): Promise<void>;
  /** First circle on a server: pass `setupToken`. More circles: pass `admin`, a client already on that server. */
  createCircle(opts: { serverUrl: string; setupToken?: string; admin?: CircleClient; name: string; circleName: string }): Promise<void>;
  previewInvite(link: string): Promise<InvitePreview>;
  joinWithInvite(link: string, opts: { name: string }): Promise<void>;
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
    ts?: number;
  }): Promise<void>;
  /** Remove this device's location from the circle (stop sharing with it). */
  clearLocation(): Promise<void>;
  requestLocations(targets?: string[]): Promise<{ requested: number; online: number; pushed: number; cooldown: number }>;
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
  /** Stop sharing with this circle; it sees that you paused. */
  pauseSharing(): Promise<void>;
  sendEvent(body: Record<string, unknown>): Promise<void>;
  /** Add or remove this person's reaction. Doesn't trigger a notification. */
  react(messageId: string, emoji: string): Promise<void>;
  reactionsFor(messageId: string): Reaction[];
  fetchPlaces(): Promise<Map<string, Place>>;
  savePlace(p: { id?: string; name: string; lat: number; lng: number; radius?: number; icon?: string; address?: string | null; group?: string | null }): Promise<string>;
  deletePlace(id: string): Promise<void>;
  createInvite(opts?: { hours?: number }): Promise<Invite>;
  setName(name: string): Promise<void>;
  setCircleName(name: string): Promise<void>;
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
