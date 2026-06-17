// SPDX-FileCopyrightText: 2026 Gavin McFall
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import { PairedState } from '@/lib/storage';
import { api } from '@/lib/api-client';
import { bc } from '@/lib/browser-compat';
import type { UploadStatus } from '@/types/messages';
import { GoblinMark } from './GoblinMark';

interface Credential {
  id: string;
  label: string;
  status: 'active' | 'expired' | 'revoked';
}

interface SiteConfigMatch {
  siteId: string;
  name?: string;
  displayName?: string;
  matches: string[];
}

type UploadSnapshot = Pick<UploadStatus, 'lastRunAt' | 'pendingCount' | 'lastError'>;

function matchGlob(pattern: string, url: string): boolean {
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return re.test(url);
}

function statusLabel(creds: Credential[]): { text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
  if (creds.length === 0) return { text: 'no session shared', tone: 'idle' };
  const active = creds.find((c) => c.status === 'active');
  if (active) return { text: 'session active', tone: 'ok' };
  const expired = creds.find((c) => c.status === 'expired');
  if (expired) return { text: 'session expired', tone: 'warn' };
  return { text: 'session revoked', tone: 'bad' };
}

function prettySiteName(match: SiteConfigMatch | null, fallback: string | null): string {
  if (!match) return fallback ?? 'this site';
  if (match.displayName) return match.displayName;
  if (match.name) return match.name;
  // siteId is usually lowercase ("makerworld") — give it a nice capital.
  const id = match.siteId;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function StatusView({
  state,
  onUnpair,
}: {
  state: PairedState;
  onUnpair: () => void;
}) {
  const [match, setMatch] = useState<SiteConfigMatch | null>(null);
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);
  const [creds, setCreds] = useState<Credential[]>([]);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadSnapshot | null>(null);

  // Initial fetch — adapter match + credentials for the current site.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [tab] = await bc.tabs.query({ active: true, currentWindow: true });
        if (cancelled || !tab?.url) return;
        try {
          if (!cancelled) setCurrentDomain(new URL(tab.url).hostname);
        } catch {
          // chrome:// or about: pages have no parseable hostname
        }
        const res = await api<{ configs: SiteConfigMatch[] }>('/api/v1/site-configs');
        if (cancelled) return;
        const m =
          res.configs.find((c) => c.matches.some((mm) => matchGlob(mm, tab.url!))) ?? null;
        if (m) {
          if (!cancelled) setMatch(m);
          const cr = await api<{ credentials: Credential[] }>(
            `/api/v1/source-credentials/${m.siteId}`,
          );
          if (!cancelled) setCreds(cr.credentials);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load site state');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Single upload-status poller — shared by Today's loot AND footer so we
  // don't double the background round-trips per popup open.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      if (cancelled) return;
      try {
        const res = await bc.runtime.sendMessage({ type: 'upload-status' });
        if (res?.ok && !cancelled) {
          setUpload(res.data as UploadSnapshot);
        }
      } catch {
        // background not ready yet; retry
      }
      timer = setTimeout(refresh, 5000);
    }
    refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  async function share() {
    if (!match || !currentDomain) return;
    setSharing(true);
    setError(null);
    try {
      const res = await bc.runtime.sendMessage({
        type: 'share-credential',
        payload: { sourceId: match.siteId, domain: currentDomain },
      });
      if (!res?.ok) {
        setError((res?.error as string) ?? 'Share failed');
        return;
      }
      const cr = await api<{ credentials: Credential[] }>(
        `/api/v1/source-credentials/${match.siteId}`,
      );
      setCreds(cr.credentials);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Share failed');
    } finally {
      setSharing(false);
    }
  }

  function openApp() {
    bc.tabs.create({ url: state.serverUrl });
  }

  const status = statusLabel(creds);

  return (
    <div className="lg-status">
      {match ? (
        <header className="lg-hero">
          <div className="lg-hero-sigil">
            <GoblinMark size={140} color="var(--accent)" />
          </div>
          <div className="lg-hero-eyebrow">
            <span className={`lg-status-dot ${status.tone}`} />
            paired · {status.text}
          </div>
          <div className="lg-hero-prefix">On the hunt at</div>
          <div className="lg-hero-site">{prettySiteName(match, currentDomain)}</div>
          <div className="lg-hero-sub">{status.text}</div>

          <div className="lg-hero-actions">
            <button
              type="button"
              className="lg-btn-primary"
              onClick={share}
              disabled={sharing}
            >
              {sharing
                ? 'Sharing…'
                : creds.length === 0
                  ? 'Share session'
                  : 'Re-share session'}
            </button>
          </div>
        </header>
      ) : (
        <>
          <header className="lg-hero">
            <div className="lg-hero-sigil">
              <GoblinMark size={140} color="var(--accent)" />
            </div>
            <div className="lg-hero-eyebrow">
              <span className="lg-status-dot idle" />
              paired · idle
            </div>
            <div className="lg-hero-prefix">Paired with</div>
            <div className="lg-hero-site" style={{ fontSize: 22 }}>
              {state.serverUrl}
            </div>
          </header>
          <div className="lg-noadapter">
            <div className="lg-noadapter-title">No goblin for this site (yet).</div>
            <div className="lg-noadapter-host">
              {currentDomain ?? 'no current tab'}
            </div>
          </div>
        </>
      )}

      {error && (
        <div style={{ padding: '0 18px' }}>
          <div className="lg-error">{error}</div>
        </div>
      )}

      <section className="lg-section">
        <div className="lg-section-head">
          <span className="lg-eyebrow">Today&apos;s loot</span>
          <span className="rule" />
        </div>
        <TodaysLoot upload={upload} />
      </section>

      <Footer
        serverUrl={state.serverUrl}
        onUnpair={onUnpair}
        onOpenApp={openApp}
        upload={upload}
      />
    </div>
  );
}

function TodaysLoot({ upload }: { upload: UploadSnapshot | null }) {
  if (!upload) {
    return <div className="lg-haul-empty">Checking…</div>;
  }

  if (upload.pendingCount === 0) {
    return (
      <>
        <div className="lg-haul-empty">All caught up.</div>
        {upload.lastError && (
          <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--danger)' }}>
            last error · {upload.lastError}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="lg-haul">
      <span className="lg-haul-num">{upload.pendingCount}</span>
      <span className="lg-haul-caption">
        {upload.pendingCount === 1 ? 'pending upload' : 'pending uploads'}
      </span>
    </div>
  );
}

function Footer({
  serverUrl,
  onUnpair,
  onOpenApp,
  upload,
}: {
  serverUrl: string;
  onUnpair: () => void;
  onOpenApp: () => void;
  upload: UploadSnapshot | null;
}) {
  const uploadingText =
    upload === null
      ? '⇅ —'
      : upload.pendingCount === 0
        ? '⇅ all caught up'
        : `⇅ ${upload.pendingCount} uploading`;

  return (
    <footer className="lg-footer">
      <span className="lg-mono-faint" title={serverUrl}>
        {uploadingText}
      </span>
      <span className="lg-footer-end">
        <a
          href="https://github.com/gavinmcfall/lootgoblin"
          target="_blank"
          rel="noreferrer"
          className="lg-link-faint"
          title="Source code (AGPL-3.0-or-later)"
        >
          source ↗
        </a>
        <button type="button" className="lg-link-faint" onClick={onUnpair}>
          unpair
        </button>
        <button type="button" className="lg-link-mono" onClick={onOpenApp}>
          open app ↗
        </button>
      </span>
    </footer>
  );
}
