import { describe, it, expect } from 'vitest';
import { probeLatestRelease, type HttpClient } from '@/forge/slicer/github-releases';

describe('probeLatestRelease', () => {
  it('returns latest version + linux x64 asset URL + sha256', async () => {
    const mockHttp: HttpClient = {
      fetchJson: async (url: string) => {
        if (url.includes('/releases/latest')) {
          return {
            tag_name: 'version_2.7.4',
            assets: [
              {
                name: 'PrusaSlicer-2.7.4-linux-x64.AppImage',
                browser_download_url: 'https://gh/AppImage',
                size: 100000,
              },
              { name: 'SHA256SUMS', browser_download_url: 'https://gh/SHA256SUMS' },
            ],
          };
        }
        throw new Error(`unexpected ${url}`);
      },
      fetchText: async (url: string) => {
        if (url.includes('SHA256SUMS')) {
          return 'abc123  PrusaSlicer-2.7.4-linux-x64.AppImage\n';
        }
        throw new Error(`unexpected ${url}`);
      },
      fetchBytes: async () => {
        throw new Error('not used');
      },
    };
    const result = await probeLatestRelease({ slicerKind: 'prusaslicer', http: mockHttp });
    expect(result).toEqual({
      version: '2.7.4',
      assetUrl: 'https://gh/AppImage',
      assetName: 'PrusaSlicer-2.7.4-linux-x64.AppImage',
      sha256: 'abc123',
      sizeBytes: 100000,
    });
  });

  it('throws on missing linux x64 asset', async () => {
    const mockHttp: HttpClient = {
      fetchJson: async () => ({ tag_name: 'v1.0.0', assets: [{ name: 'foo-mac.dmg' }] }),
      fetchText: async () => '',
      fetchBytes: async () => {
        throw new Error('not used');
      },
    };
    await expect(
      probeLatestRelease({ slicerKind: 'orcaslicer', http: mockHttp }),
    ).rejects.toThrow(/no linux/i);
  });

  it('strips v prefix from OrcaSlicer tag and matches AppImage asset', async () => {
    const mockHttp: HttpClient = {
      fetchJson: async () => ({
        tag_name: 'v2.1.0',
        assets: [
          {
            name: 'OrcaSlicer_Linux_x86_64_V2.1.0.AppImage',
            browser_download_url: 'https://gh/Orca.AppImage',
            size: 200000,
          },
        ],
      }),
      fetchText: async () => '',
      fetchBytes: async () => {
        throw new Error('not used');
      },
    };
    const result = await probeLatestRelease({ slicerKind: 'orcaslicer', http: mockHttp });
    expect(result.version).toBe('2.1.0');
    expect(result.assetUrl).toBe('https://gh/Orca.AppImage');
    expect(result.sha256).toBe('');
  });

  it('returns empty sha256 when no SHA256SUMS file is present', async () => {
    const mockHttp: HttpClient = {
      fetchJson: async () => ({
        tag_name: 'v1.9.0',
        assets: [
          {
            name: 'BambuStudio_linux_x86_64_v01.09.00.00.AppImage',
            browser_download_url: 'https://gh/Bambu.AppImage',
            size: 300000,
          },
        ],
      }),
      fetchText: async () => '',
      fetchBytes: async () => {
        throw new Error('not used');
      },
    };
    const result = await probeLatestRelease({ slicerKind: 'bambustudio', http: mockHttp });
    expect(result.sha256).toBe('');
    expect(result.sizeBytes).toBe(300000);
  });

  it('matches linux x86_64 tar.gz asset', async () => {
    const mockHttp: HttpClient = {
      fetchJson: async () => ({
        tag_name: 'version_2.8.0',
        assets: [
          {
            name: 'PrusaSlicer-2.8.0-linux-x86_64.tar.gz',
            browser_download_url: 'https://gh/Prusa.tar.gz',
            size: 400000,
          },
        ],
      }),
      fetchText: async () => '',
      fetchBytes: async () => {
        throw new Error('not used');
      },
    };
    const result = await probeLatestRelease({ slicerKind: 'prusaslicer', http: mockHttp });
    expect(result.assetName).toBe('PrusaSlicer-2.8.0-linux-x86_64.tar.gz');
  });
});
