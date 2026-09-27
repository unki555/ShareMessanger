import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as RPointerEvent,
  type TouchEvent as RTouchEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  clearCryptoCache,
  decryptImageDataUrl,
  decryptText,
  encryptImageDataUrl,
  encryptText,
} from "./lib/crypto";
import { ShareCall } from "./lib/webrtc";
import {
  connectWs,
  fetchMe,
  getOrCreateDm,
  getProfile,
  getProfileByUsername,
  listProfiles,
  loadMessages,
  login as apiLogin,
  logout as apiLogout,
  markRead,
  onWs,
  register as apiRegister,
  sendCallSignal,
  sendEncryptedMessage,
  setPresence,
  getToken,
  setToken,
} from "./lib/api";

type AuthMode = "login" | "register";
type Step = "username" | "password" | "passcode" | "profile" | "welcome";
type ListFilter = "all" | "channels";

const usernamePattern = /^[a-zA-Z0-9._]{5,32}$/;

const RESERVED_USERNAMES = new Set([
  "share", "founder", "ceo", "ceo123", "developer", "developers", "admin", "support",
  "moderator", "official", "system", "bot", "root", "owner", "team", "staff",
  "help", "security", "null", "undefined", "api", "www", "mail",
  "shareofficial", "russia", "chapman", "owner",
]);

function isRepeatingUsername(u: string) {
  if (u.length < 5) return false;
  return /^(.)\1+$/.test(u) || /^(..)\1+$/.test(u);
}

function usernameIssues(raw: string, opts?: { forRegister?: boolean }): string | null {
  const u = raw.toLowerCase();
  if (u.length < 5) return "Минимум 5 символов";
  if (/^[0-9]/.test(u)) return "Username не может начинаться с цифры";
  if (!/^[a-z][a-z0-9._]{4,31}$/.test(u)) return "Только a-z, 0-9, . и _";
  if (isRepeatingUsername(u)) return "Слишком простой username";
  // резерв только при регистрации — вход в @russia / @chapman разрешён
  if (opts?.forRegister && RESERVED_USERNAMES.has(u)) return "Этот username зарезервирован";
  return null;
}

const passwordPattern = /^[a-zA-Z0-9!@#$%^&*._-]{6,64}$/;
const SHARE_ID = "__share_official__";
const MAX_PINS = 5;

type Profile = {
  id: string;
  username: string;
  display_name: string;
  last_seen: string;
  is_online: boolean;
  avatar_url?: string | null;
  bio?: string | null;
  created_at?: string;
  alt_usernames?: string[];
  birthday?: string | null;
};

type Channel = {
  id: string;
  name: string;
  username: string;
  avatar?: string;
  ownerId: string;
  subscribers: string[];
  createdAt: number;
};

type ChannelPost = {
  id: string;
  channelId: string;
  text: string;
  image?: string;
  createdAt: number;
  fromOwner: boolean;
};

type UiMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  fromMe: boolean;
  text: string;
  image?: string;
  voice?: string;
  createdAt: number;
  status: "sent" | "delivered" | "read";
};

type ListItem =
  | { kind: "share"; id: string; unread: number; lastText: string; lastTs: number }
  | { kind: "dm"; id: string; profile: Profile; unread: number; lastText: string; lastTs: number }
  | { kind: "channel"; id: string; channel: Channel; unread: number; lastText: string; lastTs: number };

type BubblePos = "single" | "first" | "middle" | "last";

function storageKey(uid: string, name: string) {
  return `share:${uid}:${name}`;
}

function loadUserJSON<T>(uid: string, name: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(storageKey(uid, name)) || "") as T;
  } catch {
    return fallback;
  }
}

function saveUserJSON(uid: string, name: string, value: unknown) {
  localStorage.setItem(storageKey(uid, name), JSON.stringify(value));
}


function saveAccountList(list: { token: string; user: { id: string; username: string; display_name: string; avatar_url?: string | null } }[]) {
  localStorage.setItem("share_accounts", JSON.stringify(list));
}

function hashPasscode(code: string) {
  // lightweight client hash (SSP: passcode never leaves device)
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (Math.imul(31, h) + code.charCodeAt(i)) | 0;
  return `ssp1:${code.length}:${h}`;
}

function formatCallTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatTime(ts: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function formatExact(ts: number) {
  return new Date(ts).toLocaleString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function formatLastSeen(iso: string, online: boolean, blocked = false, hideLastSeen = false) {
  if (blocked) return "был(а) давно";
  if (hideLastSeen) return "был(а) недавно";
  if (online) return "в сети";
  const t = new Date(iso).getTime();
  if (!t) return "не в сети";
  const diff = Date.now() - t;
  if (diff < 60_000) return "был(а) только что";
  if (diff < 3600_000) return `был(а) ${Math.floor(diff / 60_000)} мин. назад`;
  if (diff < 86400_000) return `был(а) сегодня в ${new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  if (diff > 30 * 86400_000) return "был(а) давно";
  return `был(а) ${new Date(t).toLocaleDateString("ru-RU")}`;
}

function isOfficial(username: string) {
  const u = username.toLowerCase();
  return u === "chapman" || u === "russia";
}

function VerifiedBadge() {
  return (
    <svg className="verified-badge" width="18" height="18" viewBox="0 0 24 24" aria-label="Официальный">
      <circle cx="12" cy="12" r="11" fill="#007aff" />
      <path d="M7 12.5l3 3 7-7" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
function formatDateLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Сегодня";
  if (d.toDateString() === yesterday.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}
function getBubblePos(msgs: UiMessage[], index: number): BubblePos {
  const cur = msgs[index];
  const prev = msgs[index - 1];
  const next = msgs[index + 1];
  const samePrev = prev && prev.fromMe === cur.fromMe && cur.createdAt - prev.createdAt < 120000;
  const sameNext = next && next.fromMe === cur.fromMe && next.createdAt - cur.createdAt < 120000;
  if (!samePrev && !sameNext) return "single";
  if (!samePrev && sameNext) return "first";
  if (samePrev && sameNext) return "middle";
  return "last";
}

function getDeviceInfo() {
  const ua = navigator.userAgent;
  let browser = "Браузер";
  if (ua.includes("Edg/")) browser = "Microsoft Edge";
  else if (ua.includes("Chrome/")) browser = "Google Chrome";
  else if (ua.includes("Firefox/")) browser = "Mozilla Firefox";
  else if (ua.includes("Safari/") && !ua.includes("Chrome")) browser = "Safari";
  let os = "Unknown OS";
  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac OS")) os = "macOS";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
  else if (ua.includes("Linux")) os = "Linux";
  const full = `${browser} · ${os} · ${ua.slice(0, 120)}${ua.length > 120 ? "…" : ""}`;
  return { browser, os, full, ua };
}

async function fetchClientIp(): Promise<string> {
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), 2000) : null;
    const r = await fetch("https://api.ipify.org?format=json", ctrl ? { signal: ctrl.signal } : undefined);
    if (t) clearTimeout(t);
    if (!r.ok) return "не определён";
    const j = await r.json();
    return (j && j.ip) || "не определён";
  } catch {
    return "не определён";
  }
}

function avatarColor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 52% 42%)`;
}

function IconSettings() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 3.269C14 2.568 13.432 2 12.731 2H11.27C10.568 2 10 2.568 10 3.269c0 .578-.396 1.074-.935 1.286q-.128.052-.253.106c-.531.23-1.162.16-1.572-.249a1.27 1.27 0 0 0-1.794 0L4.412 5.446a1.27 1.27 0 0 0 0 1.794c.41.41.48 1.04.248 1.572a8 8 0 0 0-.105.253c-.212.539-.708.935-1.286.935C2.568 10 2 10.568 2 11.269v1.462C2 13.432 2.568 14 3.269 14c.578 0 1.074.396 1.286.935q.052.128.105.253c.231.531.161 1.162-.248 1.572a1.27 1.27 0 0 0 0 1.794l1.034 1.034a1.27 1.27 0 0 0 1.794 0c.41-.41 1.04-.48 1.572-.249q.125.055.253.106c.539.212.935.708.935 1.286c0 .701.568 1.269 1.269 1.269h1.462c.701 0 1.269-.568 1.269-1.269c0-.578.396-1.074.935-1.287q.128-.05.253-.104c.531-.232 1.162-.161 1.571.248a1.27 1.27 0 0 0 1.795 0l1.034-1.034a1.27 1.27 0 0 0 0-1.794c-.41-.41-.48-1.04-.249-1.572q.055-.125.106-.253c.212-.539.708-.935 1.286-.935c.701 0 1.269-.568 1.269-1.269V11.27c0-.701-.568-1.269-1.269-1.269c-.578 0-1.074-.396-1.287-.935a8 8 0 0 0-.105-.253c-.23-.531-.16-1.162.249-1.572a1.27 1.27 0 0 0 0-1.794l-1.034-1.034a1.27 1.27 0 0 0-1.794 0c-.41.41-1.04.48-1.572.249a8 8 0 0 0-.253-.106C14.396 4.343 14 3.847 14 3.27Z"/>
        <path d="M16 12a4 4 0 1 1-8 0a4 4 0 0 1 8 0Z"/>
      </g>
    </svg>
  );
}
function IconChat() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" aria-hidden>
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19c5.523 0 10-3.582 10-8s-4.477-8-10-8S2 6.582 2 11c0 2.157 1.067 4.114 2.801 5.553C4.271 18.65 3 20 2 21c3 0 4.527-.979 6.32-2.559c1.14.36 2.38.559 3.68.559"/>
    </svg>
  );
}
function IconPhone() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.5-1.1a2 2 0 012.1-.4c.8.3 1.7.5 2.6.6a2 2 0 011.7 2z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconVideo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="6" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 10.5l6-3.5v10l-6-3.5v-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
function IconMore() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="6" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="18" cy="12" r="1.8" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M22 2L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 11a7 7 0 0014 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 18v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function AttachIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z" />
    </svg>
  );
}
function CheckMarks({ status }: { status: UiMessage["status"] }) {
  const double = status === "read";
  return (
    <span className="msg-checks" aria-hidden>
      {double ? (
        <svg width="16" height="10" viewBox="0 0 16 10">
          <path d="M1 5.2l2.8 2.8L10.2 1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 5.2l2.8 2.8L14.2 1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="10" viewBox="0 0 12 10">
          <path d="M1 5.2l2.8 2.8L10.2 1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

export default function App() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [step, setStep] = useState<Step>("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [displaySurname, setDisplaySurname] = useState("");
  const [regAvatar, setRegAvatar] = useState<string | null>(null);
  const [greetingName, setGreetingName] = useState("");
  const [usernameTaken, setUsernameTaken] = useState(false);
  const [checkingUser, setCheckingUser] = useState(false);
  const [authError, setAuthError] = useState("");
  const [bootLoading, setBootLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enteringApp, setEnteringApp] = useState(false);

  const [me, setMe] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelPosts, setChannelPosts] = useState<ChannelPost[]>([]);
  const [shareNotifs, setShareNotifs] = useState<{ id: string; text: string; ts: number; read: boolean }[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [listFilter, setListFilter] = useState<ListFilter>("all");

  const [selectedKind, setSelectedKind] = useState<"dm" | "channel" | "share" | null>(null);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [channelDraft, setChannelDraft] = useState("");
  const [shareDraft, setShareDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [ownProfileOpen, setOwnProfileOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [editUsernameOpen, setEditUsernameOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editAvatar, setEditAvatar] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [setupPasscode, setSetupPasscode] = useState("");
  const [setupPasscode2, setSetupPasscode2] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [channelFormOpen, setChannelFormOpen] = useState(false);
  const [chName, setChName] = useState("");
  const [chUser, setChUser] = useState("");
  const [chAvatar, setChAvatar] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: ListItem } | null>(null);
  const [lastByPeer, setLastByPeer] = useState<Record<string, { text: string; ts: number; unread: number; username?: string; display_name?: string; avatar_url?: string | null }>>({});
  const [sendError, setSendError] = useState("");

  // calls
  const [callActive, setCallActive] = useState(false);
  const [callVideo, setCallVideo] = useState(false);
  const [callStatus, setCallStatus] = useState("");
  const [callConnected, setCallConnected] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [camOff, setCamOff] = useState(false);
  const [incomingCall, setIncomingCall] = useState<{ fromId: string; video: boolean } | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [recording, setRecording] = useState(false);
  const [waveLevels, setWaveLevels] = useState<number[]>(() => Array(24).fill(0.15));
  const [recordedVoice, setRecordedVoice] = useState<string | null>(null);
  const [photoQueue, setPhotoQueue] = useState<string[]>([]);
  const [photoCaption, setPhotoCaption] = useState("");
  const [photoPreviewOpen, setPhotoPreviewOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chats" | "contacts" | "settings">("chats");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [pcSettingsOpen, setPcSettingsOpen] = useState(false);
  const [settingsSub, setSettingsSub] = useState<null | "privacy" | "devices" | "myprofile">(null);
  const [privacyDetail, setPrivacyDetail] = useState<null | string>(null);
  const [privacyPrefs, setPrivacyPrefs] = useState(() => {
    try {
      return {
        lastSeen: "everyone",
        photos: "everyone",
        about: "everyone",
        calls: "everyone",
        voice: "everyone",
        messages: "everyone",
        ...JSON.parse(localStorage.getItem("share_privacy") || "{}"),
      };
    } catch {
      return { lastSeen: "everyone", photos: "everyone", about: "everyone", calls: "everyone", voice: "everyone", messages: "everyone" };
    }
  });
  const [cloudPwdForm, setCloudPwdForm] = useState({ old: "", next: "", next2: "" });
  const [passcodeForm, setPasscodeForm] = useState({ next: "", next2: "" });
  const [passcodeEnabled, setPasscodeEnabled] = useState(() => !!localStorage.getItem("share_passcode_hash"));
  const [passcodeGate, setPasscodeGate] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeError, setPasscodeError] = useState("");
  const [savedAccounts, setSavedAccounts] = useState<{ token: string; user: { id: string; username: string; display_name: string; avatar_url?: string | null } }[]>(() => {
    try { return JSON.parse(localStorage.getItem("share_accounts") || "[]"); } catch { return []; }
  });
  const [cloudPwdHint, setCloudPwdHint] = useState(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunks = useRef<Blob[]>([]);
  const callListeners = useRef<Map<string, ShareCall>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveRaf = useRef<number>(0);
  const callRef = useRef<ShareCall | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const regFileRef = useRef<HTMLInputElement>(null);
  const chFileRef = useRef<HTMLInputElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const listTouchX = useRef(0);
  const listTouchY = useRef(0);
  const listTouchItem = useRef<ListItem | null>(null);
  const dragStartX = useRef(0);
  const longPressTimer = useRef<number | null>(null);
  const convCache = useRef<Record<string, string>>({});

  const validUsername = useMemo(
    () => !usernameIssues(username, { forRegister: mode === "register" }),
    [username, mode],
  );
  const usernameError = useMemo(
    () => (username.length >= 1 ? usernameIssues(username, { forRegister: mode === "register" }) : null),
    [username, mode],
  );
  const validPassword = useMemo(() => passwordPattern.test(password), [password]);


  const wipeDeviceLocalData = () => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("share:") || k.startsWith("share_"))) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    setChannels([]);
    setChannelPosts([]);
    setShareNotifs([]);
    setPinnedIds([]);
    setBlockedIds([]);
    setLastByPeer({});
    setMessages([]);
    convCache.current = {};
    clearCryptoCache();
  };

  const loadLocalForUser = (uid: string) => {
    setChannels(loadUserJSON(uid, "channels", [] as Channel[]));
    setChannelPosts(loadUserJSON(uid, "channel_posts", [] as ChannelPost[]));
    setShareNotifs(loadUserJSON(uid, "share_msgs", [] as { id: string; text: string; ts: number; read: boolean }[]));
    setPinnedIds(loadUserJSON(uid, "pins", [] as string[]));
    setBlockedIds(loadUserJSON(uid, "blocked", [] as string[]));
    setLastByPeer(loadUserJSON(uid, "last_by_peer", {} as Record<string, { text: string; ts: number; unread: number; username?: string; display_name?: string; avatar_url?: string | null }>));
    setMessages([]);
    convCache.current = {};
    clearCryptoCache();
  };

  const persistLastByPeer = (uid: string, map: Record<string, { text: string; ts: number; unread: number; username?: string; display_name?: string; avatar_url?: string | null }>) => {
    saveUserJSON(uid, "last_by_peer", map);
  };

  const pushShareNotif = useCallback((uid: string, text: string) => {
    const n = { id: `s_${Date.now()}`, text, ts: Date.now(), read: false };
    setShareNotifs((prev) => {
      const next = [n, ...prev].slice(0, 80);
      saveUserJSON(uid, "share_msgs", next);
      return next;
    });
  }, []);

  async function loadMeFromServer() {
    const user = await fetchMe();
    if (user) {
      const p: Profile = {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        last_seen: user.last_seen,
        is_online: user.is_online,
        avatar_url: user.avatar_url,
        bio: user.bio,
        created_at: user.created_at,
        alt_usernames: user.alt_usernames,
        birthday: user.birthday,
      };
      setMe(p);
      loadLocalForUser(user.id);
      void setPresence(true);
      return p;
    }
    return null;
  }

  async function loadProfilesFast() {
    try {
      const list = await listProfiles();
      setProfiles(
        list.map((u) => ({
          id: u.id,
          username: u.username,
          display_name: u.display_name,
          last_seen: u.last_seen,
          is_online: u.is_online,
          avatar_url: u.avatar_url,
          bio: u.bio,
          created_at: u.created_at,
          alt_usernames: u.alt_usernames,
          birthday: u.birthday,
        })),
      );
    } catch (e) {
      console.warn(e);
    }
  }

  const enterMessenger = async (_userId?: string) => {
    setEnteringApp(true);
    await loadMeFromServer();
    await loadProfilesFast();
    connectWs();
    setTimeout(() => {
      setStep("welcome");
      setEnteringApp(false);
    }, 400);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await loadMeFromServer();
      if (p && !cancelled) {
        await loadProfilesFast();
        connectWs();
        setStep("welcome");
      }
      if (!cancelled) setBootLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!me) return;
    const beat = setInterval(() => void setPresence(true), 30000);
    const off = onWs((msg) => {
      if (msg.type === "presence") {
        setProfiles((prev) =>
          prev.map((p) =>
            p.id === msg.userId
              ? { ...p, is_online: msg.online, last_seen: msg.last_seen }
              : p,
          ),
        );
        if (me && msg.userId === me.id) {
          setMe((m) => (m ? { ...m, is_online: msg.online, last_seen: msg.last_seen } : m));
        }
      }
    });
    return () => {
      clearInterval(beat);
      off();
      void setPresence(false);
    };
  }, [me?.id]);



  // WebSocket: входящие сообщения, прочтения, звонки
  useEffect(() => {
    if (!me) return;
    const off = onWs((msg) => {
      if (msg.type === "message") {
        const row = msg.message;
        if (row.sender_id === me.id) return;
        void (async () => {
          let peer = profiles.find((p) => p.id === row.sender_id) || null;
          if (!peer) {
            try {
              const u = await getProfile(row.sender_id);
              peer = {
                id: u.id,
                username: u.username,
                display_name: u.display_name,
                last_seen: u.last_seen,
                is_online: u.is_online,
                avatar_url: u.avatar_url,
                bio: u.bio,
              };
              setProfiles((prev) => (prev.some((x) => x.id === peer!.id) ? prev : [...prev, peer!]));
            } catch { /* */ }
          }
          const peerName = peer?.username || "user";
          let preview = "Сообщение";
          let text = "";
          let image: string | undefined;
          let voice: string | undefined;
          try {
            if (row.content_type === "image") {
              preview = "Фото";
              image = (await decryptImageDataUrl(row.ciphertext, row.iv, me.username, peerName)) || undefined;
            } else if (row.content_type === "voice") {
              preview = "Голосовое";
              voice = (await decryptImageDataUrl(row.ciphertext, row.iv, me.username, peerName)) || undefined;
              text = "🎤 Голосовое";
            } else {
              const t = await decryptText(row.ciphertext, row.iv, me.username, peerName);
              if (t) {
                text = t;
                preview = t.length > 40 ? t.slice(0, 40) + "…" : t;
              }
            }
          } catch { /* */ }

          const ts = new Date(row.created_at).getTime();
          const openHere =
            selectedKind === "dm" &&
            selectedPeerId === row.sender_id &&
            conversationId === row.conversation_id;

          setLastByPeer((p) => {
            const next = {
              ...p,
              [row.sender_id]: {
                text: preview,
                ts,
                unread: openHere ? 0 : (p[row.sender_id]?.unread || 0) + 1,
                username: peer?.username || p[row.sender_id]?.username,
                display_name: peer?.display_name || p[row.sender_id]?.display_name,
                avatar_url: peer?.avatar_url ?? p[row.sender_id]?.avatar_url,
              },
            };
            persistLastByPeer(me.id, next);
            return next;
          });

          if (openHere) {
            const ui: UiMessage = {
              id: row.id,
              conversationId: row.conversation_id,
              senderId: row.sender_id,
              fromMe: false,
              text,
              image,
              voice,
              createdAt: ts,
              status: "delivered",
            };
            setMessages((prev) => (prev.some((m) => m.id === ui.id) ? prev : [...prev, ui]));
            void markRead(row.id);
          }
        })();
      }
      if (msg.type === "read") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.message_id && m.fromMe ? { ...m, status: "read" as const } : m,
          ),
        );
      }
      if (msg.type === "call_signal") {
        const from = msg.from;
        const payload = msg.payload as { type?: string; video?: boolean };
        let call = callListeners.current.get(from);
        if (!call) {
          call = new ShareCall(
            me.id,
            from,
            {
              onLocalStream: () => {},
              onRemoteStream: () => {},
              onEnded: () => {},
              onError: () => {},
              onStatus: () => {},
              onIncoming: (f, video) => setIncomingCall({ fromId: f, video }),
            },
            (to, pl) => sendCallSignal(to, pl),
          );
          callListeners.current.set(from, call);
          void call.listenOnly();
        }
        call.handleSignal({ ...payload, from });
      }
    });
    return () => off();
  }, [me?.id, me?.username, profiles, selectedKind, selectedPeerId, conversationId]);



  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, channelPosts.length, conversationId]);

  useEffect(() => {
    if (!callActive || !callConnected) return;
    setCallSeconds(0);
    const t = setInterval(() => setCallSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [callActive, callConnected]);

  useEffect(() => {
    const close = () => { setCtxMenu(null); setMoreOpen(false); setAccountMenuOpen(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const continueFromUsername = async () => {
    if (!validUsername) return;
    setAuthError("");
    setUsernameTaken(false);
    // вход: не проверяем резерв / занятость — пароль проверит сервер
    if (mode === "login") {
      setGreetingName(username);
      setStep("password");
      return;
    }
    setCheckingUser(true);
    try {
      await getProfileByUsername(username);
      setCheckingUser(false);
      setUsernameTaken(true);
    } catch {
      setCheckingUser(false);
      setGreetingName(username);
      setStep("password");
    }
  };

  const continueFromPassword = async () => {
    if (!validPassword) return;
    setAuthError("");
    if (mode === "register") { setStep("profile"); return; }
    setBusy(true);
    try {
      const { user } = await apiLogin({ username, password });
      const dev = getDeviceInfo();
      const ip = await fetchClientIp();
      const when = formatExact(Date.now());
      const tok = getToken();
      if (tok) {
        setSavedAccounts((prev) => {
          const next = [
            ...prev.filter((a) => a.user.id !== user.id),
            {
              token: tok,
              user: {
                id: user.id,
                username: user.username,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
              },
            },
          ].slice(-5);
          saveAccountList(next);
          return next;
        });
      }
      if (localStorage.getItem("share_passcode_hash")) setPasscodeGate(true);
      pushShareNotif(
        user.id,
        `Вход с нового устройства.\n\nМы обнаружили вход в Ваш аккаунт с нового устройства в ${when}.\n\nУстройство: ${dev.full}\nIP: ${ip}\n\nЕсли это были не Вы, немедленно завершите все сессии кроме текущей в настройках безопасности вашего аккаунта.`,
      );
      await enterMessenger(user.id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setAuthError(code === "invalid_credentials" ? "Неверный пароль или username" : (e instanceof Error ? e.message : "Ошибка входа"));
    }
    setBusy(false);
  };

  const completeRegistration = async (withPasscode: boolean) => {
    if (!displayName.trim()) return;
    setBusy(true);
    setAuthError("");
    try {
      if (withPasscode) {
        if (!/^\d{4,8}$/.test(setupPasscode)) {
          setAuthError("Код-пароль: 4–8 цифр");
          setBusy(false);
          return;
        }
        if (setupPasscode !== setupPasscode2) {
          setAuthError("Коды не совпадают");
          setBusy(false);
          return;
        }
        localStorage.setItem("share_passcode_hash", hashPasscode(setupPasscode));
        setPasscodeEnabled(true);
      }
      wipeDeviceLocalData();
      const fullName = [displayName.trim(), displaySurname.trim()].filter(Boolean).join(" ");
      const { user } = await apiRegister({
        username,
        password,
        display_name: fullName,
        avatar_url: regAvatar,
      });
      wipeDeviceLocalData();
      loadLocalForUser(user.id);
      const tok = getToken();
      if (tok) {
        setSavedAccounts((prev) => {
          const next = [
            ...prev.filter((a) => a.user.id !== user.id),
            {
              token: tok,
              user: {
                id: user.id,
                username: user.username,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
              },
            },
          ].slice(-5);
          saveAccountList(next);
          return next;
        });
      }
      const dev = getDeviceInfo();
      const ip = await fetchClientIp();
      const when = formatExact(Date.now());
      pushShareNotif(
        user.id,
        `Вход с нового устройства.\n\nМы обнаружили вход в Ваш аккаунт с нового устройства в ${when}.\n\nУстройство: ${dev.full}\nIP: ${ip}\n\nАккаунт @${username} успешно создан.\n\nЕсли это были не Вы, немедленно завершите все сессии кроме текущей в настройках безопасности вашего аккаунта.`,
      );
      await enterMessenger(user.id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setAuthError(code === "username_taken" ? "Данный username занят" : (e instanceof Error ? e.message : "Ошибка регистрации"));
    }
    setBusy(false);
  };

  const continueFromPasscodeSetup = () => {
    void completeRegistration(true);
  };

  const skipPasscodeSetup = () => {
    void completeRegistration(false);
  };

  const finishProfile = () => {
    if (!displayName.trim()) return;
    setAuthError("");
    setStep("passcode");
  };

  const savePrivacy = (key: string, value: string) => {
    setPrivacyPrefs((p) => {
      const next = { ...p, [key]: value };
      localStorage.setItem("share_privacy", JSON.stringify(next));
      return next;
    });
  };

  const switchAccount = async (acc: { token: string; user: { id: string; username: string; display_name: string; avatar_url?: string | null } }) => {
    setAccountMenuOpen(false);
    callRef.current?.hangup(false);
    setToken(acc.token);
    setMe(null);
    setMessages([]);
    setLastByPeer({});
    setConversationId(null);
    setSelectedPeerId(null);
    setEnteringApp(true);
    const p = await loadMeFromServer();
    if (p) {
      loadLocalForUser(p.id);
      await loadProfilesFast();
      connectWs();
      if (localStorage.getItem("share_passcode_hash")) setPasscodeGate(true);
      setStep("welcome");
    } else {
      setStep("username");
    }
    setEnteringApp(false);
  };

  const addAnotherAccount = () => {
    setAccountMenuOpen(false);
    callRef.current?.hangup(false);
    void setPresence(false);
    // не трогаем список аккаунтов, только выходим из текущего UI
    setMe(null);
    setMessages([]);
    setLastByPeer({});
    setConversationId(null);
    setSelectedPeerId(null);
    setStep("username");
    setMode("login");
    setPassword("");
    setUsername("");
  };

  const logout = async () => {
    callRef.current?.hangup();
    void setPresence(false);
    apiLogout();
    setMe(null);
    setMessages([]);
    setChannels([]);
    setChannelPosts([]);
    setSelectedPeerId(null);
    setConversationId(null);
    setMobileShowChat(false);
    clearCryptoCache();
    setStep("username");
  };

  const openDm = async (peer: Profile) => {
    if (!me) return;
    if (blockedIds.includes(peer.id)) {
      alert("Пользователь в чёрном списке. Разблокируйте в профиле.");
      return;
    }
    setSelectedKind("dm");
    setSelectedPeerId(peer.id);
    setSelectedChannelId(null);
    setMobileShowChat(true);
    setProfileOpen(false);
    setMoreOpen(false);
    setDraft("");
    setSendError("");
    setMessages([]);
    setLastByPeer((p) => {
      const next = {
        ...p,
        [peer.id]: { ...(p[peer.id] || { text: "", ts: 0, unread: 0 }), unread: 0 },
      };
      persistLastByPeer(me.id, next);
      return next;
    });

    let convId = convCache.current[peer.id];
    if (!convId) {
      try {
        convId = await getOrCreateDm(peer.id);
        convCache.current[peer.id] = convId;
      } catch (e) {
        setSendError(e instanceof Error ? e.message : "Не удалось открыть чат");
        return;
      }
    }
    setConversationId(convId);

    let rows: Awaited<ReturnType<typeof loadMessages>>["messages"] = [];
    let reads: Awaited<ReturnType<typeof loadMessages>>["reads"] = [];
    try {
      const data = await loadMessages(convId, 80);
      rows = data.messages;
      reads = data.reads;
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Ошибка загрузки");
      return;
    }

    if (!rows?.length) { setMessages([]); return; }

    const readMap = new Set(reads.filter((r) => r.user_id !== me.id).map((r) => r.message_id));

    const ui: UiMessage[] = [];
    for (const row of rows) {
      let text = "";
      let image: string | undefined;
      let voice: string | undefined;
      if (row.content_type === "image") {
        const img = await decryptImageDataUrl(row.ciphertext, row.iv, me.username, peer.username);
        if (!img) continue;
        image = img;
      } else if (row.content_type === "voice") {
        const v = await decryptImageDataUrl(row.ciphertext, row.iv, me.username, peer.username);
        if (!v) continue;
        voice = v;
        text = "🎤 Голосовое";
      } else {
        const t = await decryptText(row.ciphertext, row.iv, me.username, peer.username);
        if (t == null) continue;
        text = t;
      }
      ui.push({
        id: row.id, conversationId: row.conversation_id, senderId: row.sender_id,
        fromMe: row.sender_id === me.id, text, image, voice,
        createdAt: new Date(row.created_at).getTime(),
        status: row.sender_id === me.id ? (readMap.has(row.id) ? "read" : "delivered") : "read",
      });
    }
    setMessages(ui);
    for (const r of rows.filter((x) => x.sender_id !== me.id)) {
      void markRead(r.id);
    }
    const last = ui[ui.length - 1];
    if (last) {
      setLastByPeer((p) => ({
        ...p,
        [peer.id]: { text: last.image ? "Фото" : last.text, ts: last.createdAt, unread: 0 },
      }));
    }
  };

  const openShare = () => {
    setSelectedKind("share");
    setSelectedPeerId(null);
    setSelectedChannelId(null);
    setConversationId(null);
    setMobileShowChat(true);
    setProfileOpen(false);
    if (!me) return;
    setShareNotifs((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      saveUserJSON(me.id, "share_msgs", next);
      return next;
    });
  };

  const openChannel = (ch: Channel) => {
    setSelectedKind("channel");
    setSelectedChannelId(ch.id);
    setSelectedPeerId(null);
    setConversationId(null);
    setMobileShowChat(true);
    setProfileOpen(false);
    setChannelDraft("");
  };

  const closeChat = () => {
    setMobileShowChat(false);
    setSelectedKind(null);
    setSelectedPeerId(null);
    setSelectedChannelId(null);
    setConversationId(null);
    setMessages([]);
    setProfileOpen(false);
    setMoreOpen(false);
  };

  const openListItem = (it: ListItem) => {
    if (it.kind === "share") openShare();
    else if (it.kind === "dm") void openDm(it.profile);
    else openChannel(it.channel);
  };

  const togglePin = (id: string) => {
    if (!me) return;
    let next: string[];
    if (pinnedIds.includes(id)) next = pinnedIds.filter((x) => x !== id);
    else {
      if (pinnedIds.length >= MAX_PINS) {
        alert(`Максимум ${MAX_PINS} закреплений`);
        return;
      }
      next = [id, ...pinnedIds];
    }
    setPinnedIds(next);
    saveUserJSON(me.id, "pins", next);
  };

  const toggleBlock = (peerId: string) => {
    if (!me) return;
    const next = blockedIds.includes(peerId)
      ? blockedIds.filter((id) => id !== peerId)
      : [...blockedIds, peerId];
    setBlockedIds(next);
    saveUserJSON(me.id, "blocked", next);
    setMoreOpen(false);
    if (next.includes(peerId)) {
      setProfileOpen(false);
      closeChat();
    }
  };

  const clearChatHistory = () => {
    setMessages([]);
    setMoreOpen(false);
  };

  const startCall = async (video: boolean) => {
    if (!me || !selectedPeerId) return;
    // локальная настройка: если peer запретил звонки (храним у себя как prefs peer — упрощённо глобальный флаг на peer id)
    const peerCallBan = localStorage.getItem(`share_nocall:${selectedPeerId}`) === "1";
    if (peerCallBan || privacyPrefs.calls === "nobody") {
      alert(peerCallBan || privacyPrefs.calls === "nobody"
        ? "Пользователь не принимает звонки."
        : "Звонки недоступны.");
      return;
    }
    connectWs();
    if (callRef.current) callRef.current.hangup(false);
    setCallVideo(video);
    setCallActive(true);
    setMicMuted(false);
    setSpeakerOn(true);
    setCallStatus("Звоним…");
    const call = new ShareCall(me.id, selectedPeerId, {
      onLocalStream: (stream) => {
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          void localVideoRef.current.play().catch(() => {});
        }
      },
      onRemoteStream: (stream) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
          void remoteVideoRef.current.play().catch(() => {});
        }
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.muted = false;
          void remoteAudioRef.current.play().catch(() => {});
        }
      },
      onEnded: () => {
        setCallActive(false);
        setCallConnected(false);
        setCallStatus("");
        callRef.current = null;
      },
      onError: (m) => setCallStatus(m),
      onStatus: (st) => {
        if (st === "connected") {
          setCallStatus("");
          setCallConnected(true);
        } else setCallStatus(st);
      },
      onConnected: () => {
        setCallConnected(true);
        setCallStatus("");
      },
    }, (to, pl) => sendCallSignal(to, pl));
    callRef.current = call;
    setCallConnected(false);
    setCamOff(false);
    try {
      await call.start(video, true);
    } catch (e) {
      setCallStatus(e instanceof Error ? e.message : "Нет доступа к микрофону/камере");
      setCallActive(false);
    }
  };

  const endCall = () => {
    callRef.current?.hangup();
    setCallActive(false);
    setCallConnected(false);
    setCallSeconds(0);
    setIncomingCall(null);
  };


  const stopWaveAnim = () => {
    if (waveRaf.current) cancelAnimationFrame(waveRaf.current);
    waveRaf.current = 0;
    try { audioCtxRef.current?.close(); } catch { /* */ }
    audioCtxRef.current = null;
    analyserRef.current = null;
    setWaveLevels(Array(24).fill(0.15));
  };

  const startVoice = async () => {
    if (!me || selectedKind !== "dm") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      src.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const bars = Array.from({ length: 24 }, (_, i) => {
          const v = data[i % data.length] / 255;
          return Math.max(0.12, Math.min(1, v * 1.4));
        });
        setWaveLevels(bars);
        waveRaf.current = requestAnimationFrame(tick);
      };
      tick();

      const rec = new MediaRecorder(stream);
      recordChunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) recordChunks.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopWaveAnim();
        const blob = new Blob(recordChunks.current, { type: "audio/webm" });
        if (blob.size < 200) return;
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") setRecordedVoice(reader.result);
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecordedVoice(null);
    } catch {
      alert("Нет доступа к микрофону");
    }
  };

  const stopVoice = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  };

  const cancelVoice = () => {
    try { mediaRecorderRef.current?.stop(); } catch { /* */ }
    mediaRecorderRef.current = null;
    setRecording(false);
    setRecordedVoice(null);
    stopWaveAnim();
  };

  const sendRecordedVoice = () => {
    if (!recordedVoice) return;
    const v = recordedVoice;
    setRecordedVoice(null);
    void sendMessage("", undefined, v);
  };

  const sendMessage = useCallback(
    async (text?: string, imageDataUrl?: string, voiceDataUrl?: string) => {
      const body = (text ?? draft).trim();
      if ((!body && !imageDataUrl && !voiceDataUrl) || !me || !conversationId || !selectedPeerId || selectedKind !== "dm") return;
      const peer = profiles.find((p) => p.id === selectedPeerId);
      if (!peer) return;
      setSendError("");
      const contentType = voiceDataUrl ? "voice" : imageDataUrl ? "image" : "text";
      const plain = voiceDataUrl || imageDataUrl || body;
      const tempId = `tmp_${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: tempId, conversationId, senderId: me.id, fromMe: true,
          text: voiceDataUrl ? "🎤 Голосовое" : imageDataUrl ? "" : body,
          image: imageDataUrl,
          voice: voiceDataUrl,
          createdAt: Date.now(), status: "sent",
        },
      ]);
      if (!imageDataUrl && !voiceDataUrl) setDraft("");
      setLastByPeer((p) => {
        const next = {
          ...p,
          [peer.id]: {
            text: voiceDataUrl ? "Голосовое" : imageDataUrl ? "Фото" : body,
            ts: Date.now(),
            unread: 0,
            username: peer.username,
            display_name: peer.display_name,
            avatar_url: peer.avatar_url,
          },
        };
        persistLastByPeer(me.id, next);
        return next;
      });
      try {
        const enc =
          contentType === "text"
            ? await encryptText(plain, me.username, peer.username)
            : await encryptImageDataUrl(plain, me.username, peer.username);
        const data = await sendEncryptedMessage(conversationId, {
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          content_type: contentType,
        });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? { ...m, id: data.id, createdAt: new Date(data.created_at).getTime(), status: "delivered" }
              : m,
          ),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSendError(msg.includes("fetch") ? "Нет связи с сервером. Сообщение сохранено локально." : msg);
      }
      inputRef.current?.focus();
    },
    [draft, me, conversationId, selectedPeerId, profiles, selectedKind],
  );

  const sendChannelPost = () => {
    if (!me || !selectedChannelId) return;
    const text = channelDraft.trim();
    if (!text) return;
    const post: ChannelPost = {
      id: `cp_${Date.now()}`,
      channelId: selectedChannelId,
      text,
      createdAt: Date.now(),
      fromOwner: true,
    };
    setChannelPosts((prev) => {
      const next = [...prev, post];
      saveUserJSON(me.id, "channel_posts", next);
      // also store globally for subscribers on same browser demo
      try {
        const all = JSON.parse(localStorage.getItem("share_channel_posts_global") || "[]") as ChannelPost[];
        all.push(post);
        localStorage.setItem("share_channel_posts_global", JSON.stringify(all));
      } catch { /* */ }
      return next;
    });
    setChannelDraft("");
  };

  const visibleChannelPosts = useMemo(() => {
    if (!selectedChannelId) return [];
    const local = channelPosts.filter((p) => p.channelId === selectedChannelId);
    try {
      const global = (JSON.parse(localStorage.getItem("share_channel_posts_global") || "[]") as ChannelPost[])
        .filter((p) => p.channelId === selectedChannelId);
      const map = new Map<string, ChannelPost>();
      [...global, ...local].forEach((p) => map.set(p.id, p));
      return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      return local;
    }
  }, [channelPosts, selectedChannelId]);

  const onPickPhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const readers = files.slice(0, 6).map(
      (file) =>
        new Promise<string | null>((resolve) => {
          if (!file.type.startsWith("image/")) return resolve(null);
          if (file.size > 1_500_000) {
            alert("Фото до ~1.5 МБ");
            return resolve(null);
          }
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
          reader.readAsDataURL(file);
        }),
    );
    void Promise.all(readers).then((urls) => {
      const ok = urls.filter(Boolean) as string[];
      if (!ok.length) return;
      setPhotoQueue((q) => [...q, ...ok].slice(0, 8));
      setPhotoPreviewOpen(true);
    });
  };

  const sendPhotos = async () => {
    const caption = photoCaption.trim();
    const queue = [...photoQueue];
    setPhotoPreviewOpen(false);
    setPhotoQueue([]);
    setPhotoCaption("");
    for (let i = 0; i < queue.length; i++) {
      const text = i === queue.length - 1 && caption ? caption : undefined;
      if (text) {
        await sendMessage(text, queue[i]);
      } else {
        await sendMessage("", queue[i]);
      }
    }
  };

  const createChannel = () => {
    if (!me || !chName.trim() || !usernamePattern.test(chUser)) return;
    const ch: Channel = {
      id: `ch_${Date.now()}`,
      name: chName.trim(),
      username: chUser.toLowerCase(),
      avatar: chAvatar || undefined,
      ownerId: me.id,
      subscribers: [me.id],
      createdAt: Date.now(),
    };
    const next = [ch, ...channels];
    setChannels(next);
    saveUserJSON(me.id, "channels", next);
    try {
      const g = JSON.parse(localStorage.getItem("share_channels_global") || "[]") as Channel[];
      g.unshift(ch);
      localStorage.setItem("share_channels_global", JSON.stringify(g));
    } catch { /* */ }
    setChannelFormOpen(false);
    setCreateOpen(false);
    setChName("");
    setChUser("");
    setChAvatar(null);
    openChannel(ch);
  };

  const allChannels = useMemo(() => {
    try {
      const g = JSON.parse(localStorage.getItem("share_channels_global") || "[]") as Channel[];
      const map = new Map<string, Channel>();
      [...g, ...channels].forEach((c) => map.set(c.id, c));
      return [...map.values()];
    } catch {
      return channels;
    }
  }, [channels]);

  const toggleSubscribe = (ch: Channel) => {
    if (!me) return;
    const subbed = ch.subscribers.includes(me.id);
    const updated = {
      ...ch,
      subscribers: subbed ? ch.subscribers.filter((id) => id !== me.id) : [...ch.subscribers, me.id],
    };
    const next = channels.some((c) => c.id === ch.id)
      ? channels.map((c) => (c.id === ch.id ? updated : c))
      : [updated, ...channels];
    setChannels(next);
    saveUserJSON(me.id, "channels", next);
    try {
      const g = (JSON.parse(localStorage.getItem("share_channels_global") || "[]") as Channel[]).map((c) =>
        c.id === ch.id ? updated : c,
      );
      localStorage.setItem("share_channels_global", JSON.stringify(g));
    } catch { /* */ }
  };

  const onTouchStart = (e: RTouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };
  const onTouchEnd = (e: RTouchEvent) => {
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 55) return;
    if (dx > 70 && mobileShowChat) closeChat();
  };
  const onPtrDown = (e: RPointerEvent) => {
    if (e.pointerType === "touch") return;
    dragStartX.current = e.clientX;
  };
  const onPtrUp = (e: RPointerEvent) => {
    if (e.pointerType === "touch") return;
    if (e.clientX - dragStartX.current > 90 && mobileShowChat) closeChat();
  };
  const onItemTouchStart = (it: ListItem, e: RTouchEvent) => {
    listTouchX.current = e.touches[0].clientX;
    listTouchY.current = e.touches[0].clientY;
    listTouchItem.current = it;
  };
  const onItemTouchEnd = (e: RTouchEvent) => {
    const it = listTouchItem.current;
    if (!it) return;
    const dx = e.changedTouches[0].clientX - listTouchX.current;
    const dy = e.changedTouches[0].clientY - listTouchY.current;
    if (Math.abs(dy) > 50) return;
    if (dx > 72) openListItem(it);
  };

  const startLongPress = (item: ListItem, e: React.PointerEvent) => {
    const x = e.clientX, y = e.clientY;
    longPressTimer.current = window.setTimeout(() => setCtxMenu({ x, y, item }), 480);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const listItems: ListItem[] = useMemo(() => {
    const shareUnread = shareNotifs.filter((n) => !n.read).length;
    const shareLast = shareNotifs[0];
    const items: ListItem[] = [];
    const q = searchQuery.trim().toLowerCase().replace(/^@+/, "");

    if (listFilter === "all") {
      items.push({
        kind: "share", id: SHARE_ID, unread: shareUnread,
        lastText: shareLast?.text?.split("\n")[0] || "Системные уведомления",
        lastTs: shareLast?.ts || 0,
      });

      // Только те, с кем уже есть переписка (или закреп)
      const peerIds = new Set([
        ...Object.keys(lastByPeer),
        ...pinnedIds.filter((id) => id !== SHARE_ID),
      ]);

      if (q) {
        // Поиск: можно найти любого зарегистрированного и начать чат
        for (const p of profiles) {
          if (me && p.id === me.id) continue;
          if (blockedIds.includes(p.id)) continue;
          const alts = (p.alt_usernames || []).some((a) => a.toLowerCase().includes(q));
          if (
            p.username.toLowerCase().includes(q) ||
            p.display_name.toLowerCase().includes(q) ||
            alts
          ) {
            const meta = lastByPeer[p.id];
            items.push({
              kind: "dm",
              id: p.id,
              profile: p,
              unread: meta?.unread || 0,
              lastText: meta?.text || `@${p.username}`,
              lastTs: meta?.ts || 0,
            });
          }
        }
      } else {
        for (const id of peerIds) {
          if (id === SHARE_ID) continue;
          if (me && id === me.id) continue;
          if (blockedIds.includes(id)) continue;
          const meta = lastByPeer[id];
          let p = profiles.find((x) => x.id === id);
          if (!p && meta?.username) {
            p = {
              id,
              username: meta.username,
              display_name: meta.display_name || meta.username,
              last_seen: new Date(0).toISOString(),
              is_online: false,
              avatar_url: meta.avatar_url,
            };
          }
          if (!p) continue;
          items.push({
            kind: "dm",
            id: p.id,
            profile: p,
            unread: meta?.unread || 0,
            lastText: meta?.text || `@${p.username}`,
            lastTs: meta?.ts || 0,
          });
        }
      }
    }

    for (const ch of allChannels) {
      if (q && !(ch.username.toLowerCase().includes(q) || ch.name.toLowerCase().includes(q))) continue;
      items.push({
        kind: "channel", id: ch.id, channel: ch, unread: 0,
        lastText: `Канал · ${ch.subscribers.length} подп.`,
        lastTs: ch.createdAt || 0,
      });
    }

    return [...items].sort((a, b) => {
      const ap = pinnedIds.includes(a.id) ? 1 : 0;
      const bp = pinnedIds.includes(b.id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return b.lastTs - a.lastTs;
    });
  }, [profiles, allChannels, me, lastByPeer, shareNotifs, searchQuery, listFilter, pinnedIds, blockedIds]);

  const selectedPeer = profiles.find((p) => p.id === selectedPeerId);
  const selectedChannel = allChannels.find((c) => c.id === selectedChannelId);
  const hasDraft = draft.trim().length > 0;
  const isBlocked = selectedPeerId ? blockedIds.includes(selectedPeerId) : false;

  const groupedMessages = useMemo(() => {
    const groups: { label: string; items: UiMessage[] }[] = [];
    let label = "";
    for (const m of messages) {
      const l = formatDateLabel(m.createdAt);
      if (l !== label) { label = l; groups.push({ label: l, items: [m] }); }
      else groups[groups.length - 1].items.push(m);
    }
    return groups;
  }, [messages]);


  if (passcodeGate && step === "welcome" && me) {
    const digits = passcodeInput;
    return (
      <div className="passcode-overlay">
        <div className="call-fs-name" style={{ marginBottom: 8 }}>Код-пароль</div>
        <div className="passcode-dots">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={digits.length > i ? "on" : ""} />
          ))}
        </div>
        {passcodeError && <p className="auth-error">{passcodeError}</p>}
        <div className="passcode-pad">
          {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k) => (
            <button
              key={k || "sp"}
              type="button"
              style={{ visibility: k === "" ? "hidden" : "visible" }}
              onClick={() => {
                if (k === "⌫") {
                  setPasscodeInput((p) => p.slice(0, -1));
                  setPasscodeError("");
                  return;
                }
                if (!k) return;
                const next = (digits + k).slice(0, 8);
                setPasscodeInput(next);
                const stored = localStorage.getItem("share_passcode_hash");
                if (stored && next.length >= 4 && hashPasscode(next) === stored) {
                  setPasscodeGate(false);
                  setPasscodeInput("");
                  setPasscodeError("");
                } else if (next.length >= 4 && stored && hashPasscode(next) !== stored && next.length >= (stored.split(":")[1] ? Number(stored.split(":")[1]) : 4)) {
                  setPasscodeError("Неверный код");
                  setPasscodeInput("");
                }
              }}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (bootLoading || enteringApp) {
    return (
      <main className="auth-page">
        <div className="page-spinner" aria-hidden />
      </main>
    );
  }

  if (step !== "welcome") {
    return (
      <main className="auth-page">
        <section className="auth-shell">
          <motion.div className="brand" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>Share</motion.div>
          <AnimatePresence mode="wait" initial={false}>
            {step === "username" && (
              <motion.div key="u" className="auth-stage" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="mode-switch">
                  <motion.div className="mode-pill" animate={{ x: mode === "login" ? 0 : "100%" }} transition={{ type: "spring", stiffness: 420, damping: 34 }} />
                  <button className={`mode-button ${mode === "login" ? "active" : ""}`} onClick={() => { setMode("login"); setUsernameTaken(false); }}>Вход</button>
                  <button className={`mode-button ${mode === "register" ? "active" : ""}`} onClick={() => { setMode("register"); setUsernameTaken(false); }}>Регистрация</button>
                </div>
                <div className="auth-form">
                  <h1>{mode === "login" ? "Введите свой username для входа" : "Введите свой username для регистрации"}</h1>
                  {usernameTaken && <p className="field-error-label">Данный username занят</p>}
                  {!usernameTaken && usernameError && <p className="field-error-label">{usernameError}</p>}
                  <label className={`input-field ${usernameTaken || usernameError ? "error" : ""}`}>
                    <span>@</span>
                    <input value={username} onChange={(e) => { setUsernameTaken(false); setUsername(e.target.value.replace(/^@+/, "").replace(/[^a-zA-Z0-9._]/g, "").slice(0, 32)); }} placeholder="username" autoCapitalize="none" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && continueFromUsername()} />
                  </label>
                  <button className={`continue-button ${validUsername ? "enabled" : ""}`} disabled={!validUsername || checkingUser} onClick={continueFromUsername}>
                    {checkingUser ? <span className="btn-spinner" aria-hidden /> : "Продолжить"}
                  </button>
                </div>
              </motion.div>
            )}
            {step === "password" && (
              <motion.div key="p" className="auth-stage password-stage" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                <button className="back-button" onClick={() => setStep("username")}>‹</button>
                <div className="auth-form">
                  <div className="pass-monkey" aria-hidden><img src="/monkey.gif" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} /></div>
                  <p className="pass-cloud-hint">Ваш облачный пароль дополнительно защищает аккаунт.</p>
                  <div className="username-preview">@{username}</div>
                  <h1>{mode === "login" ? "Введите надёжный пароль" : "Придумайте надёжный пароль"}</h1>
                  <label className="input-field">
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value.replace(/[^a-zA-Z0-9!@#$%^&*._-]/g, "").slice(0, 64))} placeholder="Надёжный пароль" autoFocus onKeyDown={(e) => e.key === "Enter" && continueFromPassword()} />
                  </label>
                  {authError && <p className="auth-error">{authError}</p>}
                  <button className={`continue-button ${validPassword ? "enabled" : ""}`} disabled={!validPassword || busy} onClick={continueFromPassword}>
                    {busy ? <span className="btn-spinner" aria-hidden /> : "Продолжить"}
                  </button>
                </div>
              </motion.div>
            )}
            
            {step === "passcode" && (
              <motion.div key="pc" className="auth-stage" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                <button className="back-button" onClick={() => setStep("profile")}>‹</button>
                <div className="auth-form">
                  <h1>Код-пароль</h1>
                  <p className="pass-cloud-hint">Для безопасности добавьте Код-пароль при входе в Share Messenger.</p>
                  <label className="input-field spaced">
                    <input
                      type="password"
                      inputMode="numeric"
                      value={setupPasscode}
                      onChange={(e) => setSetupPasscode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                      placeholder="Код 4–8 цифр"
                      autoFocus
                    />
                  </label>
                  <label className="input-field spaced">
                    <input
                      type="password"
                      inputMode="numeric"
                      value={setupPasscode2}
                      onChange={(e) => setSetupPasscode2(e.target.value.replace(/\D/g, "").slice(0, 8))}
                      placeholder="Повторите код"
                      onKeyDown={(e) => e.key === "Enter" && continueFromPasscodeSetup()}
                    />
                  </label>
                  {authError && <p className="auth-error">{authError}</p>}
                  <button
                    className={`continue-button ${/^\d{4,8}$/.test(setupPasscode) && setupPasscode === setupPasscode2 ? "enabled" : ""}`}
                    disabled={!/^\d{4,8}$/.test(setupPasscode) || setupPasscode !== setupPasscode2}
                    onClick={continueFromPasscodeSetup}
                  >
                    Продолжить
                  </button>
                  <button type="button" className="glass-cancel" onClick={skipPasscodeSetup} style={{ marginTop: 10 }}>Пропустить</button>
                </div>
              </motion.div>
            )}
            {step === "profile" && (
              <motion.div key="pr" className="auth-stage profile-stage" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                <button className="back-button" onClick={() => setStep("password")}>‹</button>
                <div className="auth-form">
                  <button type="button" className="avatar-upload" onClick={() => regFileRef.current?.click()}>
                    {regAvatar ? <img src={regAvatar} alt="" /> : <span>+</span>}
                  </button>
                  <input ref={regFileRef} type="file" accept="image/*" hidden onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const r = new FileReader();
                    r.onload = () => { if (typeof r.result === "string") setRegAvatar(r.result); };
                    r.readAsDataURL(f);
                  }} />
                  <h1>Как вас зовут?</h1>
                  <label className="input-field spaced">
                    <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Имя" autoFocus />
                  </label>
                  <label className="input-field spaced">
                    <input value={displaySurname} onChange={(e) => setDisplaySurname(e.target.value)} placeholder="Фамилия" onKeyDown={(e) => e.key === "Enter" && finishProfile()} />
                  </label>
                  {authError && <p className="auth-error">{authError}</p>}
                  <button className={`continue-button ${displayName.trim() ? "enabled" : ""}`} disabled={!displayName.trim() || busy} onClick={finishProfile}>
                    Продолжить
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>
    );
  }

  return (
    <motion.main className={`messenger ${mobileShowChat ? "show-chat" : ""}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <aside className={`chat-sidebar tab-${mobileTab}${pcSettingsOpen ? " settings-on" : ""}`}>
        <div className="sidebar-header">
          <h2 className="sidebar-title">{mobileTab === "contacts" ? "Контакты" : mobileTab === "settings" || pcSettingsOpen ? "Настройки" : "Чаты"}</h2>
          <div className="header-actions">
            {!pcSettingsOpen && mobileTab === "chats" && (
              <button type="button" className="plus-btn" onClick={() => setCreateOpen(true)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg>
              </button>
            )}
            <div className="account-menu-wrap">
              <button type="button" className="dots-btn desktop-only" onClick={(e) => { e.stopPropagation(); setAccountMenuOpen((v) => !v); }} aria-label="Меню">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
              </button>
              <AnimatePresence>
                {accountMenuOpen && (
                  <motion.div className="account-popover" initial={{ opacity: 0, y: -6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4 }} onClick={(e) => e.stopPropagation()}>
                    {savedAccounts.map((acc) => (
                      <button
                        key={acc.user.id}
                        type="button"
                        className={`acc-row ${me?.id === acc.user.id ? "on" : ""}`}
                        onClick={() => {
                          if (me?.id === acc.user.id) {
                            setAccountMenuOpen(false);
                            setPcSettingsOpen(true);
                            setMobileTab("settings");
                          } else void switchAccount(acc);
                        }}
                      >
                        <div className="acc-av" style={{ background: avatarColor(acc.user.username) }}>
                          {acc.user.avatar_url ? <img src={acc.user.avatar_url} alt="" /> : (acc.user.display_name || acc.user.username)[0]}
                        </div>
                        <div>
                          <b>{acc.user.display_name || acc.user.username}</b>
                          <span>@{acc.user.username}</span>
                        </div>
                      </button>
                    ))}
                    {(!savedAccounts.length && me) && (
                      <button type="button" className="acc-row on" onClick={() => { setAccountMenuOpen(false); setPcSettingsOpen(true); setMobileTab("settings"); }}>
                        <div className="acc-av" style={{ background: avatarColor(me.username) }}>
                          {me.avatar_url ? <img src={me.avatar_url} alt="" /> : (me.display_name || me.username)[0]}
                        </div>
                        <div>
                          <b>{me.display_name || me.username}</b>
                          <span>@{me.username}</span>
                        </div>
                      </button>
                    )}
                    <button type="button" className="acc-add" onClick={addAnotherAccount}>Добавить аккаунт</button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <button type="button" className="logout-btn" onClick={logout}>↗</button>
          </div>
        </div>
        <div className={`search-wrap ${isSearchFocused ? "focused" : ""}`}>
          <div className="search-icon"><SearchIcon /></div>
          <input className="search-input" placeholder="Поиск по @username" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onFocus={() => setIsSearchFocused(true)} onBlur={() => setTimeout(() => setIsSearchFocused(false), 120)} autoCapitalize="none" spellCheck={false} />
        </div>
        <div className="filter-island">
          <button type="button" className={listFilter === "all" ? "on" : ""} onClick={() => setListFilter("all")}>Все</button>
          <button type="button" className={listFilter === "channels" ? "on" : ""} onClick={() => setListFilter("channels")}>Каналы</button>
        </div>

        {(mobileTab === "settings" || pcSettingsOpen) && (
          <div className="settings-pane share-settings" style={{ position: "relative" }}>
            <div className="settings-top-bar">
              <div className="settings-top-av" style={{ background: me ? avatarColor(me.username) : "#3a3a3c" }}>
                {me?.avatar_url ? <img src={me.avatar_url} alt="" /> : (me?.display_name || "?")[0]}
              </div>
              <button
                type="button"
                className="settings-izm"
                onClick={() => {
                  if (!me) return;
                  setEditName(me.display_name || "");
                  setEditBio(me.bio || "");
                  setEditAvatar(me.avatar_url || null);
                  setEditProfileOpen(true);
                }}
              >Изм.</button>
            </div>
            <div className="settings-hero-name">
              {me?.display_name || me?.username}
              
            </div>
            <div className="settings-hero-user">@{me?.username}</div>

            <div className="settings-card soft">
              <div className="settings-row static">ID: {me ? me.id.replace(/-/g, "").slice(0, 12) : "—"}</div>
            </div>

            <div className="settings-card soft">
              {savedAccounts.map((acc) => (
                <button
                  key={acc.user.id}
                  type="button"
                  className={`settings-acc-row ${me?.id === acc.user.id ? "on" : ""}`}
                  onClick={() => {
                    if (me?.id !== acc.user.id) void switchAccount(acc);
                  }}
                >
                  <div className="acc-av sm" style={{ background: avatarColor(acc.user.username) }}>
                    {acc.user.avatar_url ? <img src={acc.user.avatar_url} alt="" /> : (acc.user.display_name || acc.user.username)[0]}
                  </div>
                  <div className="settings-acc-meta">
                    <b>{acc.user.display_name || acc.user.username}</b>
                    <span>@{acc.user.username}</span>
                  </div>
                </button>
              ))}
              {(!savedAccounts.length && me) && (
                <div className="settings-acc-row on">
                  <div className="acc-av sm" style={{ background: avatarColor(me.username) }}>
                    {me.avatar_url ? <img src={me.avatar_url} alt="" /> : (me.display_name || me.username)[0]}
                  </div>
                  <div className="settings-acc-meta">
                    <b>{me.display_name || me.username}</b>
                    <span>@{me.username}</span>
                  </div>
                </div>
              )}
              <div className="settings-sep" />
              <button type="button" className="settings-row accent" onClick={addAnotherAccount}>+ Добавить аккаунт</button>
            </div>

            <div className="settings-card soft">
              <button type="button" className="settings-row" onClick={() => setSettingsSub("myprofile")}>
                Мой профиль <span className="chev">›</span>
              </button>
            </div>

            <div className="settings-card soft">
              <button type="button" className="settings-row" onClick={() => setSettingsSub("privacy")}>
                Конфиденциальность <span className="chev">›</span>
              </button>
              <div className="settings-sep" />
              <button type="button" className="settings-row" onClick={() => setSettingsSub("devices")}>
                Устройства <span className="chev">›</span>
              </button>
              <div className="settings-sep" />
              <button type="button" className="settings-row danger" onClick={logout}>Выйти</button>
            </div>
            {pcSettingsOpen && (
              <button type="button" className="settings-back desktop-only" onClick={() => { setPcSettingsOpen(false); setMobileTab("chats"); setSettingsSub(null); }}>‹ К чатам</button>
            )}

            <AnimatePresence>
              {settingsSub === "privacy" && (
                <motion.div
                  className="settings-subpane"
                  initial={{ x: "-100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "-100%" }}
                  transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                >
                  <div className="settings-sub-header">
                    <button type="button" onClick={() => { setSettingsSub(null); setPrivacyDetail(null); }}>‹</button>
                    <h3>Конфиденциальность</h3>
                  </div>
                  <div className="settings-sub-body">
                    <div className="settings-card soft">
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("blacklist")}>
                        Чёрный список <span className="meta">{blockedIds.length}</span><span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("passcode")}>
                        Код-пароль <span className="meta">{passcodeEnabled ? "Вкл" : "Выкл"}</span><span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("cloud")}>
                        Облачный пароль <span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("lastSeen")}>
                        Время захода <span className="meta">{privacyPrefs.lastSeen === "everyone" ? "Все" : "Никто"}</span><span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("photos")}>
                        Фотографии профиля <span className="meta">{privacyPrefs.photos === "everyone" ? "Все" : "Никто"}</span><span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("about")}>
                        Раздел о себе <span className="meta">{privacyPrefs.about === "everyone" ? "Все" : "Никто"}</span><span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("calls")}>
                        Звонки <span className="meta">{privacyPrefs.calls === "everyone" ? "Все" : "Никто"}</span><span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("voice")}>
                        Голосовые <span className="meta">{privacyPrefs.voice === "everyone" ? "Все" : "Никто"}</span><span className="chev">›</span>
                      </button>
                      <div className="settings-sep" />
                      <button type="button" className="settings-row" onClick={() => setPrivacyDetail("messages")}>
                        Сообщения <span className="meta">{privacyPrefs.messages === "everyone" ? "Все" : "Никто"}</span><span className="chev">›</span>
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
              {settingsSub === "devices" && (
                <motion.div
                  className="settings-subpane"
                  initial={{ x: "-100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "-100%" }}
                  transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                >
                  <div className="settings-sub-header">
                    <button type="button" onClick={() => setSettingsSub(null)}>‹</button>
                    <h3>Устройства</h3>
                  </div>
                  <div className="settings-sub-body">
                    <div className="settings-card soft">
                      <div className="settings-row" style={{ cursor: "default" }}>
                        <div>
                          <div>Это устройство</div>
                          <div className="meta" style={{ margin: "4px 0 0" }}>{getDeviceInfo().full}</div>
                        </div>
                      </div>
                      <div className="settings-sep" />
                      <div className="settings-row" style={{ cursor: "default" }}>
                        <div>
                          <div>Chrome · Windows</div>
                          <div className="meta" style={{ margin: "4px 0 0" }}>Москва · 2 ч назад</div>
                        </div>
                      </div>
                      <div className="settings-sep" />
                      <div className="settings-row" style={{ cursor: "default" }}>
                        <div>
                          <div>Safari · iPhone</div>
                          <div className="meta" style={{ margin: "4px 0 0" }}>Санкт-Петербург · вчера</div>
                        </div>
                      </div>
                      <div className="settings-sep" />
                      <button
                        type="button"
                        className="settings-row danger"
                        onClick={() => {
                          // оставить только текущий аккаунт в списке
                          if (me) {
                            const tok = getToken();
                            const only = tok
                              ? [{ token: tok, user: { id: me.id, username: me.username, display_name: me.display_name, avatar_url: me.avatar_url } }]
                              : [];
                            setSavedAccounts(only);
                            saveAccountList(only);
                          }
                          alert("Все сессии кроме текущей завершены на этом устройстве.");
                        }}
                      >
                        Завершить все сессии кроме текущей
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}

              {settingsSub === "myprofile" && me && (
                <motion.div
                  className="settings-subpane share-prof-inline"
                  initial={{ x: "-100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "-100%" }}
                  transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
                >
                  <div className="settings-sub-header">
                    <button type="button" onClick={() => setSettingsSub(null)}>‹</button>
                    <h3>Мой профиль</h3>
                    <button
                      type="button"
                      className="settings-izm"
                      onClick={() => {
                        setEditName(me.display_name || "");
                        setEditBio(me.bio || "");
                        setEditAvatar(me.avatar_url || null);
                        setEditProfileOpen(true);
                      }}
                    >Изм.</button>
                  </div>
                  <div className="settings-sub-body prof-center">
                    <div className="drawer-avatar" style={{ background: avatarColor(me.username) }}>
                      {me.avatar_url ? <img src={me.avatar_url} alt="" /> : (me.display_name || me.username)[0]}
                    </div>
                    <div className="drawer-title-name">
                      {me.display_name || me.username}
                      
                    </div>
                    <div className="drawer-username-main">@{me.username}</div>
                    {me.bio && (
                      <div className="drawer-card" style={{ width: "100%", marginTop: 10 }}>
                        <div className="drawer-row col">
                          <span className="label">о себе</span>
                          <span>{me.bio}</span>
                        </div>
                      </div>
                    )}
                    <div className="drawer-card">
                      <div className="drawer-row muted">ID: {me.id.replace(/-/g, "").slice(0, 12)}</div>
                      <div className="drawer-line" />
                      <div className="drawer-row muted">
                        Дата регистрации
                        <div className="sub">{me.created_at ? new Date(me.created_at).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) : "—"}</div>
                      </div>
                    </div>
                    <div className="drawer-card">
                      <div className="drawer-row col">
                        <span className="label">имя пользователя</span>
                        <button type="button" className="copy-user" onClick={() => navigator.clipboard.writeText("@" + me.username)}>@{me.username}</button>
                      </div>
                      {me.birthday && (
                        <>
                          <div className="drawer-line" />
                          <div className="drawer-row muted">
                            День рождения
                            <div className="sub">{me.birthday}</div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {mobileTab === "contacts" && !pcSettingsOpen && (
          <div className="contacts-pane">
            {profiles.filter((p) => me && p.id !== me.id && !blockedIds.includes(p.id)).map((p) => (
              <button key={p.id} type="button" className="contact-row" onClick={() => void openDm(p)}>
                <div className="chat-avatar" style={{ background: avatarColor(p.username) }}>
                  {p.avatar_url ? <img src={p.avatar_url} alt="" /> : (p.display_name || p.username)[0]}
                </div>
                <div>
                  <b>{p.display_name || p.username}</b>
                  <span>@{p.username}</span>
                </div>
              </button>
            ))}
          </div>
        )}
        {mobileTab === "chats" && !pcSettingsOpen && (
        <div className="chat-list-area">
          <div className="chat-list">
            <AnimatePresence initial={false}>
              {listItems.map((it, idx) => {
                const active =
                  (it.kind === "share" && selectedKind === "share") ||
                  (it.kind === "dm" && selectedPeerId === it.profile.id) ||
                  (it.kind === "channel" && selectedChannelId === it.channel.id);
                const title = it.kind === "share" ? "Share" : it.kind === "dm" ? it.profile.display_name || it.profile.username : it.channel.name;
                const color = it.kind === "share" ? "#007aff" : it.kind === "dm" ? avatarColor(it.profile.username) : avatarColor(it.channel.username);
                const online = it.kind === "dm" && it.profile.is_online;
                const avatarSrc = it.kind === "dm" ? it.profile.avatar_url : it.kind === "channel" ? it.channel.avatar : undefined;
                const pinned = pinnedIds.includes(it.id);
                return (
                  <motion.div key={it.id} className="chat-item-wrap" layout={false}>
                    <button
                      type="button"
                      className={`chat-item ${active ? "active" : ""}`}
                      onClick={() => openListItem(it)}
                      onTouchStart={(e) => onItemTouchStart(it, e)}
                      onTouchEnd={onItemTouchEnd}
                      onPointerDown={(e) => startLongPress(it, e)}
                      onPointerUp={cancelLongPress}
                      onPointerLeave={cancelLongPress}
                      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, item: it }); }}
                    >
                      <div className="chat-avatar-wrap">
                        <div className="chat-avatar" style={{ background: color }}>
                          {avatarSrc ? <img src={avatarSrc} alt="" /> : title[0]}
                        </div>
                        {online && <span className="online-dot" />}
                      </div>
                      <div className="chat-info">
                        <div className="chat-top">
                          <b>{pinned && <span className="pin-mark"><PinIcon /></span>}{title}{it.kind === "channel" ? " · канал" : ""}</b>
                          <span className="chat-time">{formatTime(it.lastTs)}</span>
                        </div>
                        <div className="chat-bottom">
                          <span className="chat-preview">{it.lastText}</span>
                          {it.unread > 0 && <span className="unread">{it.unread}</span>}
                        </div>
                      </div>
                    </button>
                    {idx < listItems.length - 1 && <div className="chat-sep" />}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>
        )}
        <nav className="mobile-tabbar liquid-glass-bar">
          <div className="mobile-tabbar-track">
            <div
              className="mobile-tabbar-slider two"
              style={{
                transform: `translateX(${
                  mobileTab === "settings" || pcSettingsOpen ? 100 : 0
                }%)`,
              }}
            />
            <button type="button" className={mobileTab === "chats" && !pcSettingsOpen ? "on" : ""} onClick={() => { setMobileTab("chats"); setPcSettingsOpen(false); setSettingsSub(null); setPrivacyDetail(null); }}>
              <IconChat />
              <span>Чаты</span>
            </button>
            <button type="button" className={mobileTab === "settings" || pcSettingsOpen ? "on" : ""} onClick={() => { setMobileTab("settings"); setPcSettingsOpen(false); }}>
              <IconSettings />
              <span>Настройки</span>
            </button>
          </div>
        </nav>
      </aside>


      {privacyDetail && (mobileTab === "settings" || pcSettingsOpen) && (
        <motion.section
          className="chat-view privacy-right-panel"
          initial={{ x: "-30%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "-20%", opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
        >
          <div className="privacy-right-inner">
            <div className="settings-sub-header">
              <button type="button" onClick={() => setPrivacyDetail(null)}>‹</button>
              <h3>
                {privacyDetail === "blacklist" ? "Чёрный список"
                  : privacyDetail === "passcode" ? "Код-пароль"
                  : privacyDetail === "cloud" ? "Облачный пароль"
                  : privacyDetail === "lastSeen" ? "Время захода"
                  : privacyDetail === "photos" ? "Фотографии профиля"
                  : privacyDetail === "about" ? "О себе"
                  : privacyDetail === "calls" ? "Звонки"
                  : privacyDetail === "voice" ? "Голосовые"
                  : "Сообщения"}
              </h3>
            </div>
            <div className="settings-sub-body">
              {privacyDetail === "blacklist" && (
                <div className="settings-card soft">
                  {blockedIds.length === 0 && <div className="settings-row static">Список пуст</div>}
                  {blockedIds.map((id) => {
                    const p = profiles.find((x) => x.id === id);
                    return (
                      <div key={id}>
                        <button type="button" className="settings-row" onClick={() => toggleBlock(id)}>
                          {p ? (p.display_name || p.username) : id.slice(0, 8)}
                          <span className="meta">Разблок.</span>
                        </button>
                        <div className="settings-sep" />
                      </div>
                    );
                  })}
                </div>
              )}
              {privacyDetail === "passcode" && (
                <div className="settings-card soft" style={{ padding: 14 }}>
                  <label className="input-field spaced"><input type="password" inputMode="numeric" placeholder="Новый код 4–8 цифр" value={passcodeForm.next} onChange={(e) => setPasscodeForm((f) => ({ ...f, next: e.target.value.replace(/\D/g, "").slice(0, 8) }))} /></label>
                  <label className="input-field spaced"><input type="password" inputMode="numeric" placeholder="Повтор" value={passcodeForm.next2} onChange={(e) => setPasscodeForm((f) => ({ ...f, next2: e.target.value.replace(/\D/g, "").slice(0, 8) }))} /></label>
                  <button type="button" className="continue-button enabled" style={{ marginTop: 12 }} onClick={() => {
                    if (!/^\d{4,8}$/.test(passcodeForm.next) || passcodeForm.next !== passcodeForm.next2) return alert("Проверьте код");
                    localStorage.setItem("share_passcode_hash", hashPasscode(passcodeForm.next));
                    setPasscodeEnabled(true);
                    setPasscodeForm({ next: "", next2: "" });
                    alert("Код-пароль сохранён");
                  }}>Сохранить</button>
                  {passcodeEnabled && (
                    <button type="button" className="glass-cancel" style={{ marginTop: 8 }} onClick={() => { localStorage.removeItem("share_passcode_hash"); setPasscodeEnabled(false); }}>Отключить</button>
                  )}
                </div>
              )}
              {privacyDetail === "cloud" && (
                <div className="settings-card soft" style={{ padding: 14 }}>
                  <p className="edit-hint">Смена облачного пароля (пароль входа в аккаунт).</p>
                  <label className="input-field spaced"><input type="password" placeholder="Текущий пароль" value={cloudPwdForm.old} onChange={(e) => setCloudPwdForm((f) => ({ ...f, old: e.target.value }))} /></label>
                  <label className="input-field spaced"><input type="password" placeholder="Новый пароль" value={cloudPwdForm.next} onChange={(e) => setCloudPwdForm((f) => ({ ...f, next: e.target.value }))} /></label>
                  <label className="input-field spaced"><input type="password" placeholder="Повтор нового" value={cloudPwdForm.next2} onChange={(e) => setCloudPwdForm((f) => ({ ...f, next2: e.target.value }))} /></label>
                  <button type="button" className="continue-button enabled" style={{ marginTop: 12 }} onClick={() => {
                    if (cloudPwdForm.next.length < 6 || cloudPwdForm.next !== cloudPwdForm.next2) return alert("Пароль от 6 символов");
                    alert("Пароль обновлён локально. Полная смена на сервере — в следующем обновлении API.");
                    setCloudPwdForm({ old: "", next: "", next2: "" });
                  }}>Сохранить</button>
                </div>
              )}
              {["lastSeen", "photos", "about", "calls", "voice", "messages"].includes(privacyDetail) && (
                <div className="settings-card soft">
                  <button type="button" className="settings-row" onClick={() => savePrivacy(privacyDetail, "everyone")}>
                    Все <span className="meta">{(privacyPrefs as Record<string, string>)[privacyDetail] === "everyone" ? "✓" : ""}</span>
                  </button>
                  <div className="settings-sep" />
                  <button type="button" className="settings-row" onClick={() => savePrivacy(privacyDetail, "nobody")}>
                    Никто <span className="meta">{(privacyPrefs as Record<string, string>)[privacyDetail] === "nobody" ? "✓" : ""}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </motion.section>
      )}

      <section className="chat-view" style={{ display: privacyDetail && (mobileTab === "settings" || pcSettingsOpen) ? "none" : undefined }} onPointerDown={onPtrDown} onPointerUp={onPtrUp}>
        {selectedKind === "share" ? (
          <div className="chat-view-inner">
            <div className="chat-island-wrap">
              <div className="chat-island">
                <button type="button" className="island-back" onClick={closeChat}>‹</button>
                <div className="island-center">
                  <div className="island-name">Share</div>
                  <div className="island-status online">официальный</div>
                </div>
              </div>
            </div>
            <div className="chat-messages">
              {shareNotifs.length === 0 && <div className="empty-chat-card">Сообщений пока нет… напишите что‑нибудь</div>}
              {[...shareNotifs].slice().reverse().map((n) => (
                <motion.div
                  key={n.id}
                  className="msg-row them"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                >
                  <div className="msg-bubble bubble-single bubble-them share-bubble">
                    <span className="msg-text pre">{n.text}</span>
                    <span className="msg-meta"><span className="msg-time">{formatTime(n.ts)}</span></span>
                  </div>
                </motion.div>
              ))}
            </div>
            <div className="composer locked"><div className="composer-locked-hint">Только системные уведомления</div></div>
          </div>
        ) : selectedKind === "channel" && selectedChannel && me ? (
          <div className="chat-view-inner">
            <div className="chat-island-wrap">
              <div className="chat-island">
                <button type="button" className="island-back" onClick={closeChat}>‹</button>
                <div className="island-center">
                  <div className="island-name">{selectedChannel.name}</div>
                  <div className="island-status">{selectedChannel.subscribers.length} подписчиков</div>
                </div>
              </div>
            </div>
            <div className="chat-messages">
              {visibleChannelPosts.length === 0 && <div className="empty-chat-card">Сообщений пока нет… напишите что‑нибудь</div>}
              {visibleChannelPosts.map((p) => (
                <div key={p.id} className="msg-row them">
                  <div className="msg-bubble bubble-single bubble-them">
                    <span className="msg-text">{p.text}</span>
                    <span className="msg-meta"><span className="msg-time">{formatTime(p.createdAt)}</span></span>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            {selectedChannel.ownerId === me.id ? (
              <div className="composer">
                <div className="composer-inner">
                  <textarea className="composer-input" placeholder="Пост в канал" value={channelDraft} rows={1}
                    onChange={(e) => setChannelDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChannelPost(); } }}
                  />
                  {channelDraft.trim() && (
                    <button type="button" className="send-btn" onClick={sendChannelPost}><SendIcon /></button>
                  )}
                </div>
              </div>
            ) : (
              <div className="composer">
                <button type="button" className={`subscribe-btn ${selectedChannel.subscribers.includes(me.id) ? "subbed" : ""}`} onClick={() => toggleSubscribe(selectedChannel)}>
                  {selectedChannel.subscribers.includes(me.id) ? "Отписаться" : "Подписаться"}
                </button>
              </div>
            )}
          </div>
        ) : selectedKind === "dm" && selectedPeer && me ? (
          <div className="chat-view-inner">
            <div className="chat-island-wrap">
              <div className="chat-island" onClick={() => setProfileOpen(true)} role="button">
                <button type="button" className="island-back" onClick={(e) => { e.stopPropagation(); closeChat(); }}>‹</button>
                <div className="island-center">
                  <div className="island-name">{selectedPeer.display_name || selectedPeer.username}</div>
                  <div className={`island-status ${selectedPeer.is_online ? "online" : ""}`}>
                    {formatLastSeen(selectedPeer.last_seen, selectedPeer.is_online, blockedIds.includes(selectedPeer.id))}
                  </div>
                </div>
              </div>
            </div>
            <div className="chat-messages">
              {sendError && <div className="send-error">{sendError}</div>}
              {messages.length === 0 && <div className="empty-chat-card">Сообщений пока нет… напишите что‑нибудь</div>}
              {groupedMessages.map((g) => (
                <div key={g.label} className="msg-group">
                  <div className="msg-date-sep"><span>{g.label}</span></div>
                  {g.items.map((m, i) => {
                    const pos = getBubblePos(g.items, i);
                    return (
                      <motion.div
                        key={m.id}
                        className={`msg-row ${m.fromMe ? "me" : "them"}`}
                        initial={{ opacity: 0, y: 18, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.7 }}
                      >
                        <div className={`msg-bubble bubble-${pos} ${m.fromMe ? "bubble-me" : "bubble-them"} ${m.image ? "has-image" : ""}`}>
                          {m.image && <img src={m.image} alt="" className="msg-image" />}
                          {m.voice && (
                            <div className="voice-bubble">
                              <div className="wave-static msg-wave">
                                {Array.from({ length: 18 }, (_, i) => (
                                  <span key={i} style={{ height: `${8 + ((i * 7 + m.id.length) % 14)}px` }} />
                                ))}
                              </div>
                              <audio className="msg-voice" controls src={m.voice} preload="metadata" />
                            </div>
                          )}
                          {m.text && !m.voice ? <span className="msg-text">{m.text}</span> : null}
                          <span className="msg-meta">
                            <span className="msg-time">{formatTime(m.createdAt)}</span>
                            {m.fromMe && <CheckMarks status={m.status} />}
                          </span>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <div className="composer">
              {!recording && !recordedVoice && (
                <>
                  <button type="button" className="attach-island" onClick={() => fileRef.current?.click()}><AttachIcon /></button>
                  <button type="button" className="attach-island voice-btn" onClick={() => void startVoice()} title="Голосовое">
                    <MicIcon />
                  </button>
                </>
              )}
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickPhoto} />
              {recording ? (
                <div className="voice-record-bar">
                  <button type="button" className="voice-cancel" onClick={cancelVoice}>✕</button>
                  <div className="wave-live">
                    {waveLevels.map((lv, i) => (
                      <span key={i} style={{ height: `${8 + lv * 22}px` }} />
                    ))}
                  </div>
                  <button type="button" className="voice-stop" onClick={stopVoice}>■</button>
                </div>
              ) : recordedVoice ? (
                <div className="voice-record-bar">
                  <button type="button" className="voice-cancel" onClick={cancelVoice}>✕</button>
                  <div className="wave-static">
                    {Array.from({ length: 20 }, (_, i) => (
                      <span key={i} style={{ height: `${10 + Math.sin(i * 0.7) * 10 + 8}px` }} />
                    ))}
                  </div>
                  <AnimatePresence>
                    <motion.button type="button" className="send-btn" onClick={sendRecordedVoice} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                      <SendIcon />
                    </motion.button>
                  </AnimatePresence>
                </div>
              ) : (
                <div className="composer-inner">
                  <textarea ref={inputRef} className="composer-input" placeholder="Сообщение" value={draft} rows={1}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      e.target.style.height = "auto";
                      e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
                  />
                  <AnimatePresence>
                    {hasDraft && (
                      <motion.button type="button" className="send-btn" onClick={() => void sendMessage()} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }}>
                        <SendIcon />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>

            <AnimatePresence>
              {profileOpen && selectedPeer && (
                <>
                  <motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => { setProfileOpen(false); setMoreOpen(false); }} />
                  <motion.aside className="profile-drawer share-prof" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}>
                    <button type="button" className="prof-back" onClick={() => { setProfileOpen(false); setMoreOpen(false); }}>‹</button>
                    <div className="drawer-avatar" style={{ background: avatarColor(selectedPeer.username) }}>
                      {selectedPeer.avatar_url ? <img src={selectedPeer.avatar_url} alt="" /> : (selectedPeer.display_name || selectedPeer.username)[0]}
                    </div>
                    <div className="drawer-title-name">
                      {selectedPeer.display_name || selectedPeer.username}
                      
                    </div>
                    <div className="drawer-username-main">@{selectedPeer.username}</div>
                    {selectedPeer.bio && privacyPrefs.about !== "nobody" && (
                      <div className="drawer-card" style={{ marginTop: 8 }}>
                        <div className="drawer-row col">
                          <span className="label">о себе</span>
                          <span>{selectedPeer.bio}</span>
                        </div>
                      </div>
                    )}
                    <div className="drawer-seen">{formatLastSeen(selectedPeer.last_seen, selectedPeer.is_online, blockedIds.includes(selectedPeer.id))}</div>
                    <div className="profile-actions-row">
                      <button type="button" className="pa-round" onClick={() => { setProfileOpen(false); void startCall(false); }}>
                        <IconPhone /><span>звонок</span>
                      </button>
                      <button type="button" className="pa-round" onClick={() => { setProfileOpen(false); void startCall(true); }}>
                        <IconVideo /><span>видео</span>
                      </button>
                      <button type="button" className="pa-round" onClick={() => setProfileOpen(false)}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H3v6h3l5 4V5z" stroke="currentColor" strokeWidth="1.7"/><path d="M15.5 8.5a5 5 0 010 7" stroke="currentColor" strokeWidth="1.7"/></svg>
                        <span>звук</span>
                      </button>
                      <button type="button" className="pa-round" onClick={() => { setProfileOpen(false); setIsSearchFocused(true); }}>
                        <SearchIcon /><span>поиск</span>
                      </button>
                    </div>
                    <div className="drawer-card">
                      <div className="drawer-row muted">ID: {selectedPeer.id.replace(/-/g, "").slice(0, 12)}</div>
                      <div className="drawer-line" />
                      <div className="drawer-row muted">
                        Дата регистрации
                        <div className="sub">{selectedPeer.created_at ? new Date(selectedPeer.created_at).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) : "—"}</div>
                      </div>
                    </div>
                    <div className="drawer-card">
                      <div className="drawer-row col">
                        <span className="label">имя пользователя</span>
                        <button type="button" className="copy-user" onClick={() => navigator.clipboard.writeText("@" + selectedPeer.username)}>@{selectedPeer.username}</button>
                      </div>
                      {selectedPeer.birthday && (
                        <>
                          <div className="drawer-line" />
                          <div className="drawer-row muted">
                            День рождения
                            <div className="sub">{selectedPeer.birthday}</div>
                          </div>
                        </>
                      )}
                      <div className="drawer-line" />
                      <button type="button" className="drawer-action danger" onClick={() => toggleBlock(selectedPeer.id)}>
                        {isBlocked ? "Разблокировать" : "Заблокировать"}
                      </button>
                    </div>
                  </motion.aside>
                </>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className="chat-view-empty">
            <div className="empty-island">Выберите кому хотите написать</div>
          </div>
        )}
      </section>



      {/* Own profile */}
      <AnimatePresence>
        {ownProfileOpen && me && (
          <>
            <motion.div className="drawer-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOwnProfileOpen(false)} />
            <motion.aside className="profile-drawer share-prof" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}>
              <button type="button" className="prof-back" onClick={() => setOwnProfileOpen(false)}>‹</button>
              <button
                type="button"
                className="prof-edit-text"
                onClick={() => {
                  setEditName(me.display_name || "");
                  setEditBio(me.bio || "");
                  setEditAvatar(me.avatar_url || null);
                  setEditProfileOpen(true);
                }}
              >Изм.</button>
              <div className="drawer-avatar" style={{ background: avatarColor(me.username) }}>
                {me.avatar_url ? <img src={me.avatar_url} alt="" /> : (me.display_name || me.username)[0]}
              </div>
              <div className="drawer-title-name">
                {me.display_name || me.username}
                
              </div>
              <div className="drawer-username-main">@{me.username}</div>
              {(me.alt_usernames || []).length > 0 && (
                <div className="drawer-alt-users">
                  {(me.alt_usernames || []).map((u) => <span key={u}>@{u}</span>)}
                </div>
              )}
              <div className="drawer-card">
                <div className="drawer-row muted">ID: {me.id.replace(/-/g, "").slice(0, 12)}</div>
                <div className="drawer-line" />
                <div className="drawer-row muted">
                  Дата регистрации
                  <div className="sub">{me.created_at ? new Date(me.created_at).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }) : "—"}</div>
                </div>
              </div>
              <div className="drawer-card">
                <div className="drawer-row col">
                  <span className="label">имя пользователя</span>
                  <button type="button" className="copy-user" onClick={() => navigator.clipboard.writeText("@" + me.username)}>@{me.username}</button>
                  {(me.alt_usernames || []).map((u) => (
                    <button key={u} type="button" className="copy-user alt" onClick={() => navigator.clipboard.writeText("@" + u)}>@{u}</button>
                  ))}
                </div>
                {me.birthday && (
                  <>
                    <div className="drawer-line" />
                    <div className="drawer-row muted">
                      День рождения
                      <div className="sub">{me.birthday}</div>
                    </div>
                  </>
                )}
                {me.bio && (
                  <>
                    <div className="drawer-line" />
                    <div className="drawer-row muted">{me.bio}</div>
                  </>
                )}
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Edit profile */}
      <AnimatePresence>
        {editProfileOpen && me && (
          <motion.div className="edit-profile-screen" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}>
            <div className="edit-top">
              <button type="button" className="edit-chip" onClick={() => setEditProfileOpen(false)}>Отмена</button>
              <button
                type="button"
                className="edit-chip primary"
                onClick={() => {
                  setMe({ ...me, display_name: editName.trim() || me.display_name, bio: editBio, avatar_url: editAvatar });
                  setEditProfileOpen(false);
                  // local only for now + optional server patch later
                }}
              >
                Готово
              </button>
            </div>
            <label className="edit-avatar-pick">
              <div className="edit-avatar-circle" style={{ background: avatarColor(me.username) }}>
                {editAvatar ? <img src={editAvatar} alt="" /> : (
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none"><path d="M4 7h3l2-2h6l2 2h3v12H4V7z" stroke="#0a84ff" strokeWidth="1.6"/><circle cx="12" cy="13" r="3.5" stroke="#0a84ff" strokeWidth="1.6"/></svg>
                )}
              </div>
              <span>Выбрать фотографию</span>
              <input type="file" accept="image/*" hidden onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const r = new FileReader();
                r.onload = () => { if (typeof r.result === "string") setEditAvatar(r.result); };
                r.readAsDataURL(f);
              }} />
            </label>
            <div className="edit-fields">
              <input className="edit-input" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Имя" />
              <input className="edit-input muted" placeholder="Фамилия" disabled />
              <p className="edit-hint">Укажите имя и, если хотите, добавьте фотографию для Вашего профиля.</p>
              <textarea className="edit-input area" value={editBio} onChange={(e) => setEditBio(e.target.value.slice(0, 120))} placeholder="О себе" rows={2} />
              <p className="edit-hint">Напишите несколько строк о себе.</p>
              <button type="button" className="edit-row-btn" onClick={() => { setEditUsername(me.username); setEditUsernameOpen(true); }}>
                Имя пользователя
                <span>@{me.username} ›</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editUsernameOpen && me && (
          <motion.div className="edit-profile-screen" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="edit-top">
              <button type="button" className="edit-icon-btn" onClick={() => setEditUsernameOpen(false)}>✕</button>
              <div className="edit-title">Имя пользователя</div>
              <button
                type="button"
                className="edit-check"
                disabled={!!usernameIssues(editUsername, { forRegister: true }) || editUsername === me.username}
                onClick={() => {
                  if (usernameIssues(editUsername, { forRegister: true })) return;
                  setMe({ ...me, username: editUsername.toLowerCase() });
                  setEditUsernameOpen(false);
                }}
              >
                ✓
              </button>
            </div>
            <div className="edit-fields" style={{ marginTop: 40 }}>
              <p className="edit-label">ИМЯ ПОЛЬЗОВАТЕЛЯ</p>
              <label className="edit-input user-line">
                <span>Имя пользователя</span>
                <input value={editUsername} onChange={(e) => setEditUsername(e.target.value.replace(/^@+/, "").replace(/[^a-zA-Z0-9._]/g, "").toLowerCase().slice(0, 32))} />
              </label>
              {usernameIssues(editUsername, { forRegister: true }) && (
                <p className="field-error-label">{usernameIssues(editUsername, { forRegister: true })}</p>
              )}
              <p className="edit-hint">Вы можете выбрать публичное имя пользователя в Share. Другие смогут найти Вас по этому имени.</p>
              <p className="edit-hint">Можно использовать a–z, 0–9 и _. Минимальная длина — 5 символов. Не с цифры.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Incoming call — same style */}
      <AnimatePresence>
        {incomingCall && !callActive && (
          <motion.div className="call-fullscreen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="call-fs-content">
              <div
                className="call-fs-avatar"
                style={{
                  background: avatarColor(
                    profiles.find((p) => p.id === incomingCall.fromId)?.username || "x",
                  ),
                }}
              >
                {profiles.find((p) => p.id === incomingCall.fromId)?.avatar_url ? (
                  <img src={profiles.find((p) => p.id === incomingCall.fromId)!.avatar_url!} alt="" />
                ) : (
                  (profiles.find((p) => p.id === incomingCall.fromId)?.display_name ||
                    profiles.find((p) => p.id === incomingCall.fromId)?.username ||
                    "?")[0]
                )}
              </div>
              <div className="call-fs-name">
                {profiles.find((p) => p.id === incomingCall.fromId)?.display_name ||
                  profiles.find((p) => p.id === incomingCall.fromId)?.username ||
                  "Звонок"}
              </div>
              <div className="call-fs-status">
                входящий {incomingCall.video ? "видео" : ""}звонок…
              </div>
              <div className="call-fs-timer" />
              <div className="call-incoming-actions">
                <button
                  type="button"
                  className="call-pill hang"
                  onClick={() => {
                    callListeners.current.get(incomingCall.fromId)?.reject();
                    setIncomingCall(null);
                  }}
                >
                  <span className="ico">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                      <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.5-1.1a2 2 0 012.1-.4c.8.3 1.7.5 2.6.6a2 2 0 011.7 2z" stroke="currentColor" strokeWidth="1.8"/>
                      <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  </span>
                  Сбросить
                </button>
                <button
                  type="button"
                  className="call-pill"
                  onClick={() => {
                    const from = incomingCall.fromId;
                    const video = incomingCall.video;
                    setIncomingCall(null);
                    setCallVideo(video);
                    setCallActive(true);
                    setCallConnected(false);
                    setCallStatus("соединение…");
                    setCamOff(false);
                    const call = new ShareCall(
                      me!.id,
                      from,
                      {
                        onLocalStream: (stream) => {
                          if (localVideoRef.current) {
                            localVideoRef.current.srcObject = stream;
                            void localVideoRef.current.play().catch(() => {});
                          }
                        },
                        onRemoteStream: (stream) => {
                          if (remoteVideoRef.current) {
                            remoteVideoRef.current.srcObject = stream;
                            void remoteVideoRef.current.play().catch(() => {});
                          }
                          if (remoteAudioRef.current) {
                            remoteAudioRef.current.srcObject = stream;
                            remoteAudioRef.current.muted = false;
                            void remoteAudioRef.current.play().catch(() => {});
                          }
                        },
                        onEnded: () => {
                          setCallActive(false);
                          setCallConnected(false);
                          setCallStatus("");
                          callRef.current = null;
                        },
                        onError: (m) => setCallStatus(m),
                        onStatus: (st) => {
                          if (st === "connected") {
                            setCallConnected(true);
                            setCallStatus("");
                          } else setCallStatus(st);
                        },
                        onConnected: () => {
                          setCallConnected(true);
                          setCallStatus("");
                        },
                      },
                      (to, pl) => sendCallSignal(to, pl),
                    );
                    callRef.current = call;
                    void call.accept(video);
                  }}
                >
                  <span className="ico accept">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                      <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.5-1.1a2 2 0 012.1-.4c.8.3 1.7.5 2.6.6a2 2 0 011.7 2z" stroke="currentColor" strokeWidth="1.8"/>
                    </svg>
                  </span>
                  Принять
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active call — centered SF-style */}
      <AnimatePresence>
        {callActive && (
          <motion.div className="call-fullscreen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {callVideo && !camOff && (
              <div className="call-videos">
                <video ref={remoteVideoRef} className="call-remote" autoPlay playsInline />
                <video ref={localVideoRef} className="call-local" autoPlay playsInline muted />
              </div>
            )}
            <audio ref={remoteAudioRef} autoPlay />
            <div className="call-fs-content">
              <div
                className="call-fs-avatar"
                style={{
                  background: avatarColor(
                    selectedPeer?.username ||
                      profiles.find((p) => p.id === selectedPeerId)?.username ||
                      "x",
                  ),
                }}
              >
                {(selectedPeer?.avatar_url ||
                  profiles.find((p) => p.id === selectedPeerId)?.avatar_url) ? (
                  <img
                    src={
                      selectedPeer?.avatar_url ||
                      profiles.find((p) => p.id === selectedPeerId)?.avatar_url ||
                      ""
                    }
                    alt=""
                  />
                ) : (
                  (selectedPeer?.display_name || selectedPeer?.username || "?")[0]
                )}
              </div>
              <div className="call-fs-name">
                {selectedPeer?.display_name || selectedPeer?.username || "Звонок"}
              </div>
              <div className="call-fs-status">
                {callConnected ? "" : callStatus || "ожидание…"}
              </div>
              <div className="call-fs-timer">
                {callConnected ? formatCallTime(callSeconds) : ""}
              </div>
              <div className="call-fs-actions">
                <button
                  type="button"
                  className="call-pill"
                  onClick={() => alert("Демонстрация экрана — скоро")}
                >
                  <span className="ico">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                      <path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  </span>
                  Экран
                </button>
                <button
                  type="button"
                  className={`call-pill ${camOff || !callVideo ? "off" : ""}`}
                  onClick={() => {
                    if (!callVideo) {
                      setCallVideo(true);
                      setCamOff(false);
                      callRef.current?.setVideoEnabled(true);
                      return;
                    }
                    const next = !camOff;
                    setCamOff(next);
                    callRef.current?.setVideoEnabled(!next);
                  }}
                >
                  <span className="ico">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <rect x="2" y="6" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8"/>
                      <path d="M15 10.5l6-3.5v10l-6-3.5v-3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  {camOff || !callVideo ? "Вкл. видео" : "Стоп видео"}
                </button>
                <button type="button" className="call-pill hang" onClick={endCall}>
                  <span className="ico">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6 19.8 19.8 0 01-3.1-8.7A2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.3 1.8.6 2.6a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.5-1.1a2 2 0 012.1-.4c.8.3 1.7.5 2.6.6a2 2 0 011.7 2z" stroke="currentColor" strokeWidth="1.8"/>
                      <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                    </svg>
                  </span>
                  Завершить
                </button>
                <button
                  type="button"
                  className={`call-pill ${micMuted ? "off" : ""}`}
                  onClick={() => {
                    const next = !micMuted;
                    setMicMuted(next);
                    callRef.current?.setMuted(next);
                  }}
                >
                  <span className="ico">
                    <MicIcon />
                  </span>
                  {micMuted ? "Выкл. звук" : "Выкл. звук"}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Photo preview */}
      <AnimatePresence>
        {photoPreviewOpen && (
          <motion.div className="modal-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="modal-backdrop" onClick={() => { setPhotoPreviewOpen(false); setPhotoQueue([]); }} />
            <motion.div className="glass-modal wide photo-preview-modal" initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
              <p className="glass-title">Фото</p>
              <div className="photo-preview-grid">
                {photoQueue.map((src, i) => (
                  <div key={i} className="photo-preview-item">
                    <img src={src} alt="" />
                    <button type="button" className="photo-del" onClick={() => setPhotoQueue((q) => q.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                {photoQueue.length < 8 && (
                  <button type="button" className="photo-add-more" onClick={() => fileRef.current?.click()}>+</button>
                )}
              </div>
              <label className="input-field modal-field">
                <input value={photoCaption} onChange={(e) => setPhotoCaption(e.target.value)} placeholder="Подпись (необязательно)" />
              </label>
              <button type="button" className="continue-button enabled" onClick={() => void sendPhotos()} disabled={!photoQueue.length}>Отправить</button>
              <button type="button" className="glass-cancel" onClick={() => { setPhotoPreviewOpen(false); setPhotoQueue([]); setPhotoCaption(""); }}>Отмена</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {createOpen && (
          <motion.div className="modal-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="modal-backdrop" onClick={() => setCreateOpen(false)} />
            <motion.div className="glass-modal" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
              <p className="glass-title">Создать</p>
              <button type="button" className="glass-option" onClick={() => { setCreateOpen(false); setChannelFormOpen(true); }}>Канал</button>
              <button type="button" className="glass-option" onClick={() => { setCreateOpen(false); alert("Группы скоро"); }}>Группа</button>
              <button type="button" className="glass-cancel" onClick={() => setCreateOpen(false)}>Отмена</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {channelFormOpen && (
          <motion.div className="modal-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="modal-backdrop" onClick={() => setChannelFormOpen(false)} />
            <motion.div className="glass-modal wide" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
              <p className="glass-title">Новый канал</p>
              <button type="button" className="avatar-upload sm" onClick={() => chFileRef.current?.click()}>
                {chAvatar ? <img src={chAvatar} alt="" /> : <span>+</span>}
              </button>
              <input ref={chFileRef} type="file" accept="image/*" hidden onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const r = new FileReader();
                r.onload = () => { if (typeof r.result === "string") setChAvatar(r.result); };
                r.readAsDataURL(f);
              }} />
              <label className="input-field modal-field"><input value={chName} onChange={(e) => setChName(e.target.value)} placeholder="Название" /></label>
              <label className="input-field modal-field"><span>@</span><input value={chUser} onChange={(e) => setChUser(e.target.value.replace(/^@+/, "").replace(/[^a-zA-Z0-9._]/g, "").slice(0, 32))} placeholder="username" autoCapitalize="none" /></label>
              <button type="button" className={`continue-button ${chName.trim() && usernamePattern.test(chUser) ? "enabled" : ""}`} disabled={!chName.trim() || !usernamePattern.test(chUser)} onClick={createChannel}>Создать</button>
              <button type="button" className="glass-cancel" onClick={() => setChannelFormOpen(false)}>Отмена</button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => { openListItem(ctxMenu.item); setCtxMenu(null); }}>Открыть</button>
          <button type="button" onClick={() => { togglePin(ctxMenu.item.id); setCtxMenu(null); }}>
            {pinnedIds.includes(ctxMenu.item.id) ? "Открепить" : "Закрепить"}
          </button>
          <button type="button" className="danger" onClick={() => setCtxMenu(null)}>Скрыть</button>
        </div>
      )}
    </motion.main>
  );
}
