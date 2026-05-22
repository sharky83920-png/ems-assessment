// auth.js — 教官密碼閘
// auth.json 結構：{ "salt": "...", "hash": "..." }
//   - salt 是隨機 16 字元，hash = SHA-256(salt + ":" + password)
//   - hash 為空字串 → 視為未設定，所有角色直通

const Auth = (() => {
  let _hash = '';
  let _salt = '';
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
  }

  function isProtected() {
    return !!_hash;
  }

  function isUnlocked() {
    if (!isProtected()) return true;
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return stored.hash === _hash;
    } catch {
      return false;
    }
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ hash: _hash, when: Date.now() }));
      return true;
    }
    return false;
  }

  function lock() {
    localStorage.removeItem(STORAGE_KEY);
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
