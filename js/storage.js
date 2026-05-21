// storage.js — 素材儲存
// 教官端：上傳到 Firebase Storage（雲端）→ 學員/大螢幕可看
// 本機 IndexedDB 當教官端的離線快取（上傳前先暫存，網路斷時不會空白）

const DB_NAME = 'ems-initial-assessment';
const DB_VERSION = 1;
const MEDIA_STORE = 'media';

// Firebase Storage 路徑：media/{stepId}/{kind}.{ext}
function _storageRef(stepId, kind, ext) {
  if (typeof firebase === 'undefined' || !firebase.apps?.length) return null;
  try {
    return firebase.storage().ref(`media/${stepId}/${kind}.${ext}`);
  } catch (e) {
    console.error('Storage ref failed:', e);
    return null;
  }
}

// 從 Blob 的 mime 推副檔名
function _extFromBlob(blob) {
  const m = (blob.type || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('quicktime') || m.includes('mov')) return 'mov';
  return 'bin';
}

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) {
        db.createObjectStore(MEDIA_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 儲存素材：先寫 IndexedDB 當快取，然後上傳到 Firebase Storage、URL 存進 ContentSync
async function saveMedia(stepId, kind, blob, onProgress) {
  // 1) IndexedDB 快取（讓教官端立即看到，不等網路）
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readwrite');
    tx.objectStore(MEDIA_STORE).put(blob, `${stepId}:${kind}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  // 2) 上傳到 Firebase Storage（如果可用）
  const ext = _extFromBlob(blob);
  const ref = _storageRef(stepId, kind, ext);
  if (!ref) {
    console.warn('Firebase Storage 不可用，素材只存本機');
    return { localOnly: true };
  }
  try {
    const task = ref.put(blob, { contentType: blob.type });
    if (onProgress) {
      task.on('state_changed', s => {
        const pct = (s.bytesTransferred / s.totalBytes) * 100;
        onProgress(pct);
      });
    }
    await task;
    const url = await ref.getDownloadURL();
    window.ContentSync.setMediaUrl(stepId, kind, url);
    return { localOnly: false, url };
  } catch (e) {
    console.error('Firebase Storage 上傳失敗：', e);
    alert('素材上傳雲端失敗：' + (e.message || e.code || '未知錯誤') +
          '\n\n可能原因：Firebase Storage 尚未在 Firebase Console 啟用。');
    return { localOnly: true, error: e };
  }
}

async function getMedia(stepId, kind) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readonly');
    const req = tx.objectStore(MEDIA_STORE).get(`${stepId}:${kind}`);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteMedia(stepId, kind) {
  // 從 IndexedDB
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readwrite');
    tx.objectStore(MEDIA_STORE).delete(`${stepId}:${kind}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // 從 ContentSync 清掉 URL 紀錄
  if (window.ContentSync?.clearMediaUrl) {
    window.ContentSync.clearMediaUrl(stepId, kind);
  }
  // 從 Firebase Storage 刪檔（盡力而為，刪不掉不影響邏輯）
  for (const ext of ['jpg', 'png', 'webp', 'mp4', 'webm', 'mov', 'bin']) {
    const ref = _storageRef(stepId, kind, ext);
    if (ref) {
      ref.delete().catch(() => {}); // 不存在會丟錯，吞掉
    }
  }
}

async function getAllMedia() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, 'readonly');
    const store = tx.objectStore(MEDIA_STORE);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    keysReq.onsuccess = () => {
      valsReq.onsuccess = () => {
        const result = {};
        keysReq.result.forEach((k, i) => { result[k] = valsReq.result[i]; });
        resolve(result);
      };
    };
    keysReq.onerror = () => reject(keysReq.error);
  });
}

// Blob 轉 Object URL（本機快取用）
const objectURLs = new Map();
function blobToURL(stepId, kind, blob) {
  const key = `${stepId}:${kind}`;
  if (objectURLs.has(key)) URL.revokeObjectURL(objectURLs.get(key));
  const url = URL.createObjectURL(blob);
  objectURLs.set(key, url);
  return url;
}

// 給 UI 用的統一介面：回傳「可直接放 <img src> 的 URL 字串」
// 優先順序：1) 雲端 URL（學員/大螢幕能看）  2) 本機快取 blob  3) null
async function getMediaUrl(stepId, kind) {
  const cloudUrl = window.ContentSync?.getMediaUrl?.(stepId, kind);
  if (cloudUrl) return cloudUrl;
  const blob = await getMedia(stepId, kind);
  if (blob) return blobToURL(stepId, kind, blob);
  return null;
}

// 內容編輯由 ContentSync 統一處理（雲端優先、local 退回）
function getStepEdits() { return window.ContentSync.getStepEdits(); }
function saveStepEdit(stepId, field, value) { window.ContentSync.saveStepEdit(stepId, field, value); }
function getStepEdit(stepId, field) { return window.ContentSync.getStepEdit(stepId, field); }

// 匯出：所有素材 + 文字編輯 + 新增/刪除/排序 打包成單一 JSON
async function exportAllData() {
  const media = await getAllMedia();
  const mediaB64 = {};
  for (const [key, blob] of Object.entries(media)) {
    mediaB64[key] = {
      type: blob.type,
      data: await blobToBase64(blob)
    };
  }
  return {
    version: '1.2',
    exportedAt: new Date().toISOString(),
    edits: window.ContentSync.getStepEdits(),
    extraSteps: { medical: window.ContentSync.getExtraSteps('medical'), trauma: window.ContentSync.getExtraSteps('trauma') },
    deletedSteps: [...window.ContentSync.getDeletedStepIds()],
    customOrder: { medical: window.ContentSync.getCustomOrder('medical') || [], trauma: window.ContentSync.getCustomOrder('trauma') || [] },
    media: mediaB64
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(dataURL, type) {
  const parts = dataURL.split(',');
  const byteString = atob(parts[1]);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  return new Blob([ab], { type });
}

async function importAllData(data) {
  if (!data || !data.version) throw new Error('資料格式錯誤');
  // 用 ContentSync 統一寫入（會同步到 Firebase + local）
  window.ContentSync.replaceAllContent({
    edits: data.edits || {},
    extras: data.extraSteps || {},
    deleted: data.deletedSteps || [],
    order: data.customOrder || {}
  });
  if (data.media) {
    for (const [key, val] of Object.entries(data.media)) {
      const [stepId, kind] = key.split(':');
      const blob = base64ToBlob(val.data, val.type);
      await saveMedia(stepId, kind, blob);
    }
  }
}

// 新增/刪除/排序 都由 ContentSync 接手
function getExtraSteps(protocolId) { return window.ContentSync.getExtraSteps(protocolId); }
function setExtraSteps(protocolId, steps) { window.ContentSync.setExtraSteps(protocolId, steps); }
function getDeletedStepIds() { return window.ContentSync.getDeletedStepIds(); }
function setDeletedStepIds(set) { window.ContentSync.setDeletedStepIds(set); }
function getCustomOrder(protocolId) { return window.ContentSync.getCustomOrder(protocolId); }
function setCustomOrder(protocolId, idArray) { window.ContentSync.setCustomOrder(protocolId, idArray); }

window.Storage = {
  saveMedia, getMedia, deleteMedia, getAllMedia,
  blobToURL, getMediaUrl,
  saveStepEdit, getStepEdit, getStepEdits,
  getExtraSteps, setExtraSteps,
  getDeletedStepIds, setDeletedStepIds,
  getCustomOrder, setCustomOrder,
  exportAllData, importAllData
};
