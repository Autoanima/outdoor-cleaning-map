/* 名單加解密（AES-GCM，金鑰由密碼經 PBKDF2 產生）。網頁與 tools/roster.html 共用。 */
window.RosterCrypto = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64e = u8 => btoa(String.fromCharCode(...u8));
  const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function keyFrom(password, salt, iter, usage) {
    const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }

  async function encrypt(obj, password, iter = 300000) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFrom(password, salt, iter, 'encrypt');
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    return { v: 1, iter, salt: b64e(salt), iv: b64e(iv), data: b64e(data) };
  }

  /** 密碼錯誤時丟出錯誤 */
  async function decrypt(blob, password) {
    const key = await keyFrom(password, b64d(blob.salt), blob.iter, 'decrypt');
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(blob.iv) }, key, b64d(blob.data));
    return JSON.parse(dec.decode(buf));
  }

  return { encrypt, decrypt };
})();
