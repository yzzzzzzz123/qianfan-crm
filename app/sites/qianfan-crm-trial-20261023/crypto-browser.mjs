import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
export { Buffer };
export function randomBytes(n) { return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n))); }
export function createHash(name) {
  if(name !== 'sha256') throw new Error('Unsupported hash');
  const h=sha256.create();
  return {update(value){h.update(typeof value==='string'?new TextEncoder().encode(value):value);return this;},digest(format){return Buffer.from(h.digest()).toString(format);}};
}
export function scryptSync(password,salt,length) {return Buffer.from(scrypt(password,salt,{N:16384,r:8,p:1,dkLen:length}));}
export function timingSafeEqual(a,b) {if(a.length!==b.length) return false;let v=0;for(let i=0;i<a.length;i++)v|=a[i]^b[i];return v===0;}
