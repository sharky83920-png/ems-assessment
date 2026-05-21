// content-sync.js — 把使用者的內容編輯（標題、口述、新增步驟…）放上 Firebase
// 設計：用一個 in-memory 快取作為單一來源；Firebase 變動時刷新快取並通知監聽者
// 離線退回：若 Firebase 無法初始化，自動降級為 localStorage（原本的行為）

const CONTENT_PATH = 'content';
const FIELDS = ['edits', 'extras', 'deleted', 'order', 'mediaUrls'];

const LS_KEYS = {
  edits: 'ems-step-edits',
  extras: 'ems-extra-steps',
  deleted: 'ems-deleted-steps',
  order: 'ems-step-order',
  mediaUrls: 'ems-media-urls'
};

const DEFAULTS = {
  edits: () => ({}),
  extras: () => ({}),
  deleted: () => [],
  order: () => ({}),
  mediaUrls: () => ({})
};

let cache = {
  edits: DEFAULTS.edits(),
  extras: DEFAULTS.extras(),
  deleted: DEFAULTS.deleted(),
  order: DEFAULTS.order(),
  mediaUrls: DEFAULTS.mediaUrls()
};

const listeners = [];
let _initialized = false;
let _firebaseRef = null;
let _firebaseHandler = null;

function notify() {
  listeners.forEach(fn => { try { fn(cache); } catch (e) { console.error(e); } });
}

// 從 localStorage 載入到 cache（離線快取或 Firebase 不可用時）
function loadFromLocal() {
  for (const field of FIELDS) {
    try {
      const raw = localStorage.getItem(LS_KEYS[field]);
      cache[field] = raw ? JSON.parse(raw) : DEFAULTS[field]();
    } catch {
      cache[field] = DEFAULTS[field]();
    }
  }
}

// 把 cache 寫回 localStorage
function saveToLocal() {
  for (const field of FIELDS) {
    try {
      localStorage.setItem(LS_KEYS[field], JSON.stringify(cache[field]));
    } catch {}
  }
}

function initContentSync() {
  if (_initialized) return;
  _initialized = true;

  // 先載 local 當啟動值（讓 UI 有東西可顯示，不必等網路）
  loadFromLocal();

  // 嘗試接 Firebase；不行就用 local-only 模式
  if (typeof firebase === 'undefined' || !window.FIREBASE_CONFIG) {
    console.warn('Firebase 不可用，內容只存本機');
    return;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    _firebaseRef = firebase.database().ref(CONTENT_PATH);
    _firebaseHandler = (snap) => {
      const remote = snap.val();
      if (!remote) {
        // Firebase 上沒資料，把目前 local 推上去（首次上線）
        if (Object.keys(cache.edits).length || Object.keys(cache.extras).length ||
            cache.deleted.length || Object.keys(cache.order).length) {
          _firebaseRef.set(cache).catch(() => {});
        }
        return;
      }
      for (const field of FIELDS) {
        cache[field] = remote[field] || DEFAULTS[field]();
      }
      saveToLocal(); // 同步寫回 local 當離線快取
      notify();
    };
    _firebaseRef.on('value', _firebaseHandler);
  } catch (e) {
    console.error('內容同步 Firebase 初始化失敗，退回 local：', e);
  }
}

// 寫入單一欄位（會立即更新本地 + Firebase）
function writeField(field, value) {
  cache[field] = value;
  saveToLocal(); // 同步寫 local
  notify();
  if (_firebaseRef) {
    _firebaseRef.child(field).set(value).catch(e => console.error('內容上雲失敗', e));
  }
}

// 公開 API（與舊版 storage.js 的呼叫保持相容）
function getStepEdits() { return cache.edits; }
function getStepEdit(stepId, fieldName) {
  return cache.edits[stepId] && cache.edits[stepId][fieldName];
}
function saveStepEdit(stepId, fieldName, value) {
  const edits = { ...cache.edits };
  edits[stepId] = { ...(edits[stepId] || {}), [fieldName]: value };
  writeField('edits', edits);
}

function getExtraSteps(protocolId) {
  return cache.extras[protocolId] || [];
}
function setExtraSteps(protocolId, steps) {
  const extras = { ...cache.extras, [protocolId]: steps };
  writeField('extras', extras);
}

function getDeletedStepIds() { return new Set(cache.deleted); }
function setDeletedStepIds(set) {
  writeField('deleted', [...set]);
}

function getCustomOrder(protocolId) {
  return cache.order[protocolId] || null;
}
function setCustomOrder(protocolId, idArray) {
  const order = { ...cache.order, [protocolId]: idArray };
  writeField('order', order);
}

// 媒體 URL（圖片/影片在 Firebase Storage 的下載連結）
function getMediaUrl(stepId, kind) {
  return cache.mediaUrls[stepId] && cache.mediaUrls[stepId][kind];
}
function setMediaUrl(stepId, kind, url) {
  const next = { ...cache.mediaUrls };
  next[stepId] = { ...(next[stepId] || {}), [kind]: url };
  writeField('mediaUrls', next);
}
function clearMediaUrl(stepId, kind) {
  if (!cache.mediaUrls[stepId]) return;
  const next = { ...cache.mediaUrls };
  next[stepId] = { ...next[stepId] };
  delete next[stepId][kind];
  if (!Object.keys(next[stepId]).length) delete next[stepId];
  writeField('mediaUrls', next);
}

// 監聽內容變動（給 app.js 收到雲端更新時重新渲染）
function subscribeContentChange(fn) {
  listeners.push(fn);
}

// 完整重寫所有欄位（給匯入用）
function replaceAllContent(data) {
  for (const field of FIELDS) {
    if (data[field] !== undefined) cache[field] = data[field];
  }
  saveToLocal();
  notify();
  if (_firebaseRef) {
    _firebaseRef.set(cache).catch(e => console.error('整批上雲失敗', e));
  }
}

window.ContentSync = {
  init: initContentSync,
  getStepEdits, getStepEdit, saveStepEdit,
  getExtraSteps, setExtraSteps,
  getDeletedStepIds, setDeletedStepIds,
  getCustomOrder, setCustomOrder,
  getMediaUrl, setMediaUrl, clearMediaUrl,
  subscribeContentChange,
  replaceAllContent,
  isCloudMode: () => !!_firebaseRef
};
