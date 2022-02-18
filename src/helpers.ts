import { Writable } from 'stream';

export function sleep(seconds: number) {
  if (seconds > 0)
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  return Promise.resolve();
}

export function write(res: Writable, data: string | Buffer) {
  return new Promise((resolve, reject) => {
    try {
      return res.write(data, resolve)
    } catch (ex) {
      reject(ex);
    }
  });
}
