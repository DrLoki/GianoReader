import { describe, it, expect, vi } from 'vitest';
import { StorageReadError, readJsonFile, writeJsonFileAtomic } from './storage-file.js';

/** In-memory stand-in for `@tauri-apps/plugin-fs`. */
function fakeFs(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    exists: vi.fn(async (p) => store.has(p)),
    readTextFile: vi.fn(async (p) => {
      if (!store.has(p)) throw new Error('not found');
      return store.get(p);
    }),
    writeTextFile: vi.fn(async (p, content) => { store.set(p, content); }),
    rename: vi.fn(async (from, to) => {
      if (!store.has(from)) throw new Error('not found');
      store.set(to, store.get(from));
      store.delete(from);
    }),
    remove: vi.fn(async (p) => { store.delete(p); }),
  };
}

const FAST = { retries: 2, retryDelayMs: 0 };

describe('readJsonFile', () => {
  it('returns the parsed value of a valid file', async () => {
    const fs = fakeFs({ 'lib.json': '[{"id":1}]' });
    expect(await readJsonFile(fs, 'lib.json', FAST)).toEqual({ found: true, value: [{ id: 1 }] });
  });

  it('reports a missing file as not found', async () => {
    expect(await readJsonFile(fakeFs(), 'lib.json', FAST)).toEqual({ found: false });
  });

  it('reports an empty file as not found', async () => {
    const fs = fakeFs({ 'lib.json': '  \n' });
    expect(await readJsonFile(fs, 'lib.json', FAST)).toEqual({ found: false });
  });

  it('throws StorageReadError for a file that is not valid JSON', async () => {
    const fs = fakeFs({ 'lib.json': '[{"id":1},{"id"' });
    const err = await readJsonFile(fs, 'lib.json', FAST).catch((e) => e);
    expect(err).toBeInstanceOf(StorageReadError);
    expect(err.path).toBe('lib.json');
    expect(fs.readTextFile).toHaveBeenCalledTimes(3); // first attempt + 2 retries
  });

  it('throws StorageReadError when the file exists but cannot be read', async () => {
    const fs = fakeFs({ 'lib.json': '[]' });
    fs.readTextFile.mockRejectedValue(new Error('sharing violation'));
    await expect(readJsonFile(fs, 'lib.json', FAST)).rejects.toBeInstanceOf(StorageReadError);
  });

  it('recovers when a retry finds the file complete', async () => {
    const fs = fakeFs({ 'lib.json': '[1,2]' });
    fs.readTextFile.mockResolvedValueOnce('[1,'); // caught mid-write
    expect(await readJsonFile(fs, 'lib.json', FAST)).toEqual({ found: true, value: [1, 2] });
  });
});

describe('writeJsonFileAtomic', () => {
  it('writes through a temporary file and leaves only the target', async () => {
    const fs = fakeFs({ 'lib.json': '[]' });
    await writeJsonFileAtomic(fs, 'lib.json', [{ id: 1 }]);
    expect(JSON.parse(fs.store.get('lib.json'))).toEqual([{ id: 1 }]);
    expect([...fs.store.keys()]).toEqual(['lib.json']);
    // The target itself is only ever replaced by the rename
    expect(fs.writeTextFile).toHaveBeenCalledTimes(1);
    expect(fs.writeTextFile.mock.calls[0][0]).toBe('lib.json.desktop.tmp');
    expect(fs.rename).toHaveBeenCalledWith('lib.json.desktop.tmp', 'lib.json');
  });

  it('does not use the temporary name of the web server', async () => {
    const fs = fakeFs();
    await writeJsonFileAtomic(fs, 'lib.json', []);
    expect(fs.writeTextFile.mock.calls[0][0]).not.toBe('lib.json.tmp');
  });

  it('falls back to a direct write when the rename fails', async () => {
    const fs = fakeFs({ 'lib.json': '[]' });
    fs.rename.mockRejectedValue(new Error('forbidden'));
    await writeJsonFileAtomic(fs, 'lib.json', [1]);
    expect(JSON.parse(fs.store.get('lib.json'))).toEqual([1]);
    expect(fs.store.has('lib.json.desktop.tmp')).toBe(false);
  });

  it('rejects when the file cannot be written at all', async () => {
    const fs = fakeFs();
    fs.writeTextFile.mockRejectedValue(new Error('disk full'));
    await expect(writeJsonFileAtomic(fs, 'lib.json', [1])).rejects.toThrow('disk full');
  });
});
