import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MODES = ['prep', 'assembly', 'display'];
export function validTerminalCredential(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'branchId,generation,mode,terminalId,terminalKey' &&
    UUID.test(value.terminalId) &&
    UUID.test(value.branchId) &&
    MODES.includes(value.mode) &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    /^[a-f0-9]{64}$/.test(value.terminalKey)
  );
}
export function terminalCookies({ key, mode, path = '/', secure = true }) {
  if (
    !/^[a-f0-9]{64}$/.test(key ?? '') ||
    !MODES.includes(mode) ||
    !/^\/(?:[a-z/-]+\/)?$/.test(path)
  )
    throw new Error('INVALID_TERMINAL_COOKIE_CONFIG');
  const name = 'pickchick_terminal_' + mode,
    aad = Buffer.from('pickchick-terminal-v1:' + mode + ':' + path);
  const cipherKey = hkdfSync('sha256', Buffer.from(key, 'hex'), Buffer.alloc(0), aad, 32);
  const suffix = `; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return {
    clear: () => `${name}=; Max-Age=0${suffix}`,
    seal(credential) {
      if (!validTerminalCredential(credential) || credential.mode !== mode)
        throw new Error('INVALID_TERMINAL_CREDENTIAL');
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(credential), 'utf8'),
        cipher.final(),
      ]);
      return `${name}=${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}; Max-Age=31536000${suffix}`;
    },
    read(header) {
      if (typeof header !== 'string' || header.length > 4096) return null;
      const values = header
        .split(';')
        .map((x) => x.trim())
        .filter((x) => x.startsWith(name + '='));
      if (values.length !== 1) return null;
      try {
        const text = values[0].slice(name.length + 1);
        if (!/^[A-Za-z0-9_-]{40,1500}$/.test(text)) return null;
        const bytes = Buffer.from(text, 'base64url');
        if (bytes.toString('base64url') !== text) return null;
        const decipher = createDecipheriv('aes-256-gcm', cipherKey, bytes.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(12, 28));
        const value = JSON.parse(
          Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
        );
        return validTerminalCredential(value) && value.mode === mode ? value : null;
      } catch {
        return null;
      }
    },
  };
}
