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
  updatedBy: string;
}

export interface Message {
  seq: number;
  id: string;
  from: string;
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
  circleId: string | null;
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

export class CircleClient {
  constructor(opts: { storage: Storage; fetchImpl?: typeof fetch; WebSocketImpl?: any; onError?: (e: Error) => void });
  static serverInfo(serverUrl: string, fetchImpl?: typeof fetch): Promise<ServerInfo>;

  account: Account | null;
  api: Api;
  circle: { name: string };
  members: Map<string, Member>;
  locations: Map<string, MemberLocation>;
  messages: Message[];
  places: Map<string, Place>;
  status: ConnectionStatus;
  readonly me: Member | null | undefined;
  readonly isAdmin: boolean;
  readonly serverUrl: string | undefined;

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
  signOut(): Promise<void>;
  createCircle(opts: { serverUrl: string; setupToken: string; name: string; circleName: string }): Promise<void>;
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
  requestLocations(targets?: string[]): Promise<{ requested: number; online: number; pushed: number; cooldown: number }>;
  fetchMessages(): Promise<Message[]>;
  sendChat(text: string): Promise<void>;
  sendEvent(body: Record<string, unknown>): Promise<void>;
  /** Add or remove this person's reaction. Doesn't trigger a notification. */
  react(messageId: string, emoji: string): Promise<void>;
  reactionsFor(messageId: string): Reaction[];
  fetchPlaces(): Promise<Map<string, Place>>;
  savePlace(p: { id?: string; name: string; lat: number; lng: number; radius?: number; icon?: string }): Promise<string>;
  deletePlace(id: string): Promise<void>;
  createInvite(opts?: { hours?: number }): Promise<Invite>;
  setName(name: string): Promise<void>;
  setCircleName(name: string): Promise<void>;
  removeMember(id: string): Promise<void>;
  setRole(id: string, role: 'admin' | 'member'): Promise<void>;
  leave(): Promise<void>;
  rotateKey(): Promise<void>;
  start(): Promise<void>;
  connect(): void;
  /** Fetch whatever changed while the live connection was down. */
  catchUp(): Promise<void>;
  disconnect(): void;
}

export const MEMBER_COLORS: string[];
export function normalizeServerUrl(input: string): string;
export function parseInviteLink(link: string): { serverUrl: string; inviteId: string; secret: string };
export function safetyNumber(signPub: string, boxPub: string): string;

export const QUICK_REACTIONS: string[];
export const EMOJI_GROUPS: { name: string; emojis: string[] }[];
export function isEmojiOnly(text: string, max?: number): boolean;
export function isValidReaction(emoji: string): boolean;
