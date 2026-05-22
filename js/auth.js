// auth.js — 教官密碼閘
// auth.json 結構：{ "salt": "...", "hash": "..." }
//   - salt 是隨機 16 字元，hash = SHA-256(salt + ":" + password)
//   - hash 為空字串 → 視為未設定，所有角色直通

const Auth = (() => {
  let _hash = '';
  let _salt = '';
  // 一次性通行旗標：tryUnlock 成功後設為 true，下一次 isUnlocked 檢查時消耗掉
  // 設計目標：每次進入受保護角色都要重輸密碼，連同一個分頁切換角色也要
  let _justUnlocked = false;
  const STORAGE_KEY = 'ems-auth-unlock';

  async function init() {
    try {
      const res = await fetch('auth.json?_=' + Date.now());
      if (res.ok) {
        const data = await res.json();
        _hash = data.hash || '';
        _salt = data.salt || '';
      }
    } catch (e) {
      _hash = '';
    }
    // 清掉舊版本可能留下的 localStorage 記住狀態
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  function isProtected() {
    return !!_hash;
  }

  function isUnlocked() {
    if (!isProtected()) return true;
    if (_justUnlocked) {
      _justUnlocked = false;
      return true;
    }
    return false;
  }

  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function tryUnlock(password) {
    const computed = await sha256Hex(_salt + ':' + password);
    if (computed === _hash) {
      _justUnlocked = true;
      return true;
    }
    return false;
  }

  function lock() {
    _justUnlocked = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  async function generateConfig(password) {
    const saltBytes = crypto.getRandomValues(new Uint8Array(8));
    const salt = Array.from(saltBytes)
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const hash = await sha256Hex(salt + ':' + password);
    return { salt, hash };
  }

  return { init, isProtected, isUnlocked, tryUnlock, lock, generateConfig };
})();

window.Auth = Auth;
