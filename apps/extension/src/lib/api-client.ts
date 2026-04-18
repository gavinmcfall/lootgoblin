import { Storage } from './storage';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const p = await Storage.getPairing();
  if (!p) throw new Error('Not paired');
  const res = await fetch(p.serverUrl + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-api-key': p.apiKey,
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function apiPublic<T>(serverUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(serverUrl + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiUpload(path: string, fileBlob: Blob, name: string): Promise<{ ok: true; remaining: number }> {
  const p = await Storage.getPairing();
  if (!p) throw new Error('Not paired');
  const form = new FormData();
  form.append('file', fileBlob, name);
  form.append('name', name);
  const res = await fetch(p.serverUrl + path, {
    method: 'POST',
    headers: { 'x-api-key': p.apiKey }, // NO content-type — browser sets multipart boundary
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ ok: true; remaining: number }>;
}
