/**
 * Unit tests — V2-005d-c T_dc3
 *
 * Chunked HTTP multipart uploader for SDCP 3.0 printers.
 *
 * Covers:
 *   1. Happy path single chunk (1 POST, correct fields)
 *   2. Happy path multi-chunk (N POSTs with incrementing Offset, Check first vs
 *      subsequent)
 *   3. MD5 stable across all chunks
 *   4. UUID stable across all chunks
 *   5. TotalSize stable across all chunks
 *   6. 401 → auth-failed, bytesSent=0
 *   7. 400 → rejected with body excerpt
 *   8. 500 → unknown
 *   9. ECONNREFUSED → unreachable
 *   10. AbortError → timeout
 *   11. Mid-upload network failure → unreachable, bytesSent preserved
 *   12. onProgress callback invoked per successful chunk
 */

import { describe, expect, it, vi } from 'vitest';

import {
  uploadFileChunked,
  type HttpClient,
  type HttpResponseLike,
} from '../../src/forge/dispatch/sdcp/uploader';

interface Capture {
  url: string;
  init: RequestInit;
  fields: Record<string, string>;
  fileSize: number;
}

function makeOk(status = 200, body = '{"success":true}'): HttpResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: async () => body,
  };
}

function makeErr(status: number, statusText: string, body: string): HttpResponseLike {
  return {
    ok: false,
    status,
    statusText,
    text: async () => body,
  };
}

async function captureRequest(init: RequestInit): Promise<Capture> {
  const form = init.body as FormData;
  const fields: Record<string, string> = {};
  let fileSize = 0;
  for (const [key, value] of form.entries()) {
    if (key === 'File') {
      // value is a Blob in Node 22's FormData
      fileSize = (value as Blob).size;
    } else {
      fields[key] = String(value);
    }
  }
  return { url: '', init, fields, fileSize };
}

function makeRecorder() {
  const calls: Capture[] = [];
  const recorder: HttpClient['fetch'] = async (url, init) => {
    const cap = await captureRequest(init);
    cap.url = url;
    calls.push(cap);
    return makeOk();
  };
  return { calls, recorder };
}

describe('uploadFileChunked — SDCP HTTP chunked uploader', () => {
  it('1. Happy path single chunk — one POST with correct fields and success result', async () => {
    const { calls, recorder } = makeRecorder();
    const httpClient: HttpClient = { fetch: vi.fn(recorder) };

    const fileBuffer = Buffer.from('hello world resin payload');
    const result = await uploadFileChunked({
      printerIp: '192.168.1.50',
      fileBuffer,
      filename: 'model.ctb',
      httpClient,
    });

    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.bytesSent).toBe(fileBuffer.length);
    expect(result.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(result.uuid).toMatch(/^[0-9a-f-]{36}$/);

    const c = calls[0];
    expect(c.url).toBe('http://192.168.1.50:3030/uploadFile/upload');
    expect(c.init.method).toBe('POST');
    expect(c.fields.Check).toBe('1');
    expect(c.fields.Offset).toBe('0');
    expect(c.fields.TotalSize).toBe(String(fileBuffer.length));
    expect(c.fields.Uuid).toBe(result.uuid);
    expect(c.fields['S-File-MD5']).toBe(result.md5);
    expect(c.fileSize).toBe(fileBuffer.length);
  });

  it('2. Happy path multi-chunk — N POSTs with incrementing Offset and Check toggled', async () => {
    const { calls, recorder } = makeRecorder();
    const httpClient: HttpClient = { fetch: vi.fn(recorder) };

    const chunkSize = 1024;
    const fileBuffer = Buffer.alloc(3 * chunkSize + 100, 0xab); // 4 chunks total
    const result = await uploadFileChunked({
      printerIp: '10.0.0.42',
      fileBuffer,
      filename: 'big.ctb',
      chunkSize,
      httpClient,
    });

    expect(result.kind).toBe('success');
    expect(httpClient.fetch).toHaveBeenCalledTimes(4);
    expect(calls[0].fields.Check).toBe('1');
    expect(calls[1].fields.Check).toBe('0');
    expect(calls[2].fields.Check).toBe('0');
    expect(calls[3].fields.Check).toBe('0');
    expect(calls[0].fields.Offset).toBe('0');
    expect(calls[1].fields.Offset).toBe(String(chunkSize));
    expect(calls[2].fields.Offset).toBe(String(2 * chunkSize));
    expect(calls[3].fields.Offset).toBe(String(3 * chunkSize));
    expect(calls[0].fileSize).toBe(chunkSize);
    expect(calls[3].fileSize).toBe(100);
    if (result.kind === 'success') {
      expect(result.bytesSent).toBe(fileBuffer.length);
    }
  });

  it('3. MD5 stable across all chunks', async () => {
    const { calls, recorder } = makeRecorder();
    const httpClient: HttpClient = { fetch: vi.fn(recorder) };
    const fileBuffer = Buffer.alloc(2500, 0xcd);
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer,
      filename: 'a.ctb',
      chunkSize: 1024,
      httpClient,
    });
    expect(result.kind).toBe('success');
    expect(calls.length).toBe(3);
    const md5 = calls[0].fields['S-File-MD5'];
    expect(md5).toMatch(/^[0-9a-f]{32}$/);
    for (const c of calls) {
      expect(c.fields['S-File-MD5']).toBe(md5);
    }
  });

  it('4. UUID stable across all chunks', async () => {
    const { calls, recorder } = makeRecorder();
    const httpClient: HttpClient = { fetch: vi.fn(recorder) };
    const fileBuffer = Buffer.alloc(2500, 0xee);
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer,
      filename: 'a.ctb',
      chunkSize: 1024,
      httpClient,
    });
    expect(result.kind).toBe('success');
    expect(calls.length).toBe(3);
    const uuid = calls[0].fields.Uuid;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    for (const c of calls) {
      expect(c.fields.Uuid).toBe(uuid);
    }
  });

  it('5. TotalSize stable across all chunks', async () => {
    const { calls, recorder } = makeRecorder();
    const httpClient: HttpClient = { fetch: vi.fn(recorder) };
    const fileBuffer = Buffer.alloc(2500, 0x11);
    await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer,
      filename: 'a.ctb',
      chunkSize: 1024,
      httpClient,
    });
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.fields.TotalSize).toBe(String(fileBuffer.length));
    }
  });

  it('6. 401 on first chunk → auth-failed with bytesSent=0', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeErr(401, 'Unauthorized', 'go away')),
    };
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer: Buffer.from('payload'),
      filename: 'x.ctb',
      httpClient,
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('auth-failed');
    expect(result.bytesSent).toBe(0);
    expect(result.uuid).toBeDefined();
  });

  it('7. 400 → rejected with body excerpt in details', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeErr(400, 'Bad Request', 'invalid file')),
    };
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer: Buffer.from('payload'),
      filename: 'x.ctb',
      httpClient,
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('rejected');
    expect(result.details).toContain('invalid file');
    expect(result.details).toContain('400');
  });

  it('8. 500 → unknown', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => makeErr(500, 'Internal Server Error', 'oops')),
    };
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer: Buffer.from('payload'),
      filename: 'x.ctb',
      httpClient,
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('unknown');
  });

  it('9. ECONNREFUSED → unreachable', async () => {
    const err = new Error('connect ECONNREFUSED 10.0.0.1:3030') as Error & { code?: string };
    err.code = 'ECONNREFUSED';
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => {
        throw err;
      }),
    };
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer: Buffer.from('payload'),
      filename: 'x.ctb',
      httpClient,
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('unreachable');
    expect(result.bytesSent).toBe(0);
  });

  it('10. AbortError → timeout', async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => {
        throw err;
      }),
    };
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer: Buffer.from('payload'),
      filename: 'x.ctb',
      httpClient,
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('timeout');
  });

  it('10b. TimeoutError name → timeout', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => {
        throw err;
      }),
    };
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer: Buffer.from('payload'),
      filename: 'x.ctb',
      httpClient,
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('timeout');
  });

  it('11. Mid-upload network failure preserves bytesSent up to failure point', async () => {
    const chunkSize = 1024;
    const fileBuffer = Buffer.alloc(3 * chunkSize, 0x77);
    let call = 0;
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => {
        call += 1;
        if (call === 1) return makeOk();
        const err = new Error('connect ECONNREFUSED') as Error & { code?: string };
        err.code = 'ECONNREFUSED';
        throw err;
      }),
    };
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer,
      filename: 'x.ctb',
      chunkSize,
      httpClient,
    });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.reason).toBe('unreachable');
    expect(result.bytesSent).toBe(chunkSize);
  });

  it('12. onProgress callback invoked after each successful chunk', async () => {
    const { recorder } = makeRecorder();
    const httpClient: HttpClient = { fetch: vi.fn(recorder) };
    const chunkSize = 1024;
    const fileBuffer = Buffer.alloc(3 * chunkSize, 0x11);
    const progress: Array<{ bytesSent: number; totalSize: number }> = [];
    const result = await uploadFileChunked({
      printerIp: '10.0.0.1',
      fileBuffer,
      filename: 'x.ctb',
      chunkSize,
      httpClient,
      onProgress: (info) => progress.push(info),
    });
    expect(result.kind).toBe('success');
    expect(progress).toEqual([
      { bytesSent: chunkSize, totalSize: 3 * chunkSize },
      { bytesSent: 2 * chunkSize, totalSize: 3 * chunkSize },
      { bytesSent: 3 * chunkSize, totalSize: 3 * chunkSize },
    ]);
  });
});
