import { emitKeypressEvents } from 'node:readline';

/** Never accept argv, environment, redirected stdin or echoed terminal input as a password. */
export async function readHiddenPassword(
  prompt,
  { input = process.stdin, output = process.stdout } = {},
) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    throw new Error('Interactive terminal required');
  const wasRaw = input.isRaw === true;
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) {
      input.removeListener('keypress', keypress);
      input.removeListener('end', ended);
      input.removeListener('error', ended);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      const result = value;
      value = '';
      if (error) reject(new Error('Password input cancelled'));
      else resolve(result);
    }
    function ended() {
      finish(true);
    }
    function keypress(text, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return finish(true);
      if (key.name === 'return' || key.name === 'enter') return finish(false);
      if (key.name === 'backspace') {
        value = [...value].slice(0, -1).join('');
        return;
      }
      if (
        key.ctrl ||
        key.meta ||
        !text ||
        [...text].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        return;
      if (value.length + text.length > 128) return finish(true);
      value += text;
    }
    input.on('keypress', keypress);
    input.once('end', ended);
    input.once('error', ended);
  });
}
