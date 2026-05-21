// sync.js — Firebase Realtime Database 跨裝置同步
// 教官端 broadcast() → 寫入 rooms/{roomCode}/lastMessage
// 學員/大螢幕 onMessage() → 監聽該節點變化
//
// 退回模式：若 Firebase SDK 載入失敗或 config 缺漏，自動降級為 BroadcastChannel（同瀏覽器同步）

let _firebaseInitialized = false;

function ensureFirebaseInit() {
  if (_firebaseInitialized) return true;
  if (typeof firebase === 'undefined') return false;
  if (!window.FIREBASE_CONFIG) return false;
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
    }
    _firebaseInitialized = true;
    return true;
  } catch (e) {
    console.error('Firebase init failed:', e);
    return false;
  }
}

// ========== Firebase 版（跨裝置） ==========
class FirebaseRoomSync {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.ref = firebase.database().ref(`rooms/${roomCode}/lastMessage`);
    this.listeners = [];
    this.lastMessage = null;
    this._handler = (snap) => {
      const msg = snap.val();
      if (!msg) return;
      this.lastMessage = msg;
      this.listeners.forEach(fn => {
        try { fn(msg); } catch (e) { console.error('sync listener error', e); }
      });
    };
    this.ref.on('value', this._handler);
  }

  broadcast(state) {
    const msg = { ...state, ts: Date.now() };
    this.ref.set(msg).catch(e => console.error('Firebase broadcast failed:', e));
  }

  onMessage(fn) {
    this.listeners.push(fn);
    if (this.lastMessage) {
      try { fn(this.lastMessage); } catch (e) { console.error(e); }
    }
  }

  destroy() {
    try { this.ref.off('value', this._handler); } catch {}
  }
}

// ========== 退回模式：BroadcastChannel（同瀏覽器） ==========
const SYNC_KEY_PREFIX = 'ems-sync-';

class BroadcastChannelSync {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.channel = new BroadcastChannel(`ems-room-${roomCode}`);
    this.listeners = [];
    this.channel.onmessage = (e) => this._dispatch(e.data);
    this._storageHandler = (e) => {
      if (e.key === this._storeKey() && e.newValue) {
        try { this._dispatch(JSON.parse(e.newValue)); } catch {}
      }
    };
    window.addEventListener('storage', this._storageHandler);
  }
  _storeKey() { return `${SYNC_KEY_PREFIX}${this.roomCode}`; }
  _dispatch(msg) {
    this.listeners.forEach(fn => {
      try { fn(msg); } catch (e) { console.error('sync listener error', e); }
    });
  }
  broadcast(state) {
    const msg = { ...state, ts: Date.now() };
    this.channel.postMessage(msg);
    try { localStorage.setItem(this._storeKey(), JSON.stringify(msg)); } catch {}
  }
  onMessage(fn) {
    this.listeners.push(fn);
    try {
      const last = localStorage.getItem(this._storeKey());
      if (last) fn(JSON.parse(last));
    } catch {}
  }
  destroy() {
    this.channel.close();
    window.removeEventListener('storage', this._storageHandler);
  }
}

// 入口：能用 Firebase 就用，不行就退回 BroadcastChannel
function createRoomSync(roomCode) {
  if (ensureFirebaseInit()) {
    return new FirebaseRoomSync(roomCode);
  }
  console.warn('Firebase 未啟用，使用本地 BroadcastChannel 模式（僅同一瀏覽器有效）');
  return new BroadcastChannelSync(roomCode);
}

// 取得目前同步模式（給介面顯示用）
function getSyncMode() {
  return _firebaseInitialized ? 'cloud' : 'local';
}

// 產生隨機 4 位英數教室代碼
function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去除易混字
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

window.Sync = {
  create: createRoomSync,
  generateRoomCode,
  getSyncMode
};
