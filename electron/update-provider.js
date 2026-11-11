const { createRequire } = require('module');
const { normalizeReleaseNotes, MAX_RELEASE_NOTES_BYTES } = require('./release-notes');

// Resolve against the updater's own dependency tree, including dependencies.asar.
// Keep downloads and checksum verification in electron-updater.
function createDesktopUpdateProvider(updaterEntry) {
  const updaterRequire = createRequire(updaterEntry);
  const { GitHubProvider } = updaterRequire('./providers/GitHubProvider');
  const { parseUpdateInfo, getFileList } = updaterRequire('./providers/Provider');
  const { CancellationToken } = updaterRequire('builder-util-runtime');
  const semver = updaterRequire('semver');

  return class DesktopUpdateProvider extends GitHubProvider {
    releaseHighlightsCache = new Map();

    getBaseDownloadPath(tag, fileName) {
      return `${this.basePath}/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
    }

    createRequestOptions(url, headers) {
      return { ...super.createRequestOptions(url, headers), timeout: 20_000 };
    }

    async withReleaseHighlights(info, parentCancellation) {
      if (this.releaseHighlightsCache.has(info.tag)) {
        return { ...info, releaseHighlights: this.releaseHighlightsCache.get(info.tag) };
      }
      const cancellation = new CancellationToken(parentCancellation);
      const deadline = setTimeout(() => cancellation.cancel(), 4_000);
      deadline.unref?.();
      try {
        const url = new URL(this.getBaseDownloadPath(info.tag, 'release-notes.json'), this.baseUrl);
        const raw = await this.httpRequest(url, { Accept: 'application/octet-stream' }, cancellation);
        if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_RELEASE_NOTES_BYTES) return info;
        const releaseHighlights = normalizeReleaseNotes(JSON.parse(raw), info.version);
        if (!releaseHighlights) return info;
        if (this.releaseHighlightsCache.size >= 4) this.releaseHighlightsCache.clear();
        this.releaseHighlightsCache.set(info.tag, releaseHighlights);
        return { ...info, releaseHighlights };
      } catch {
        // Notes are optional for old releases. Missing/slow content must never
        // prevent a verified application update from becoming available.
        return info;
      } finally {
        clearTimeout(deadline);
        cancellation.dispose();
      }
    }

    async getLatestVersion() {
      const cancellation = new CancellationToken();
      const deadline = setTimeout(() => cancellation.cancel(), 45_000);
      deadline.unref?.();
      try {
        // GitHub's public latest endpoint avoids the API's shared-IP rate limit.
        // Compare first: an already-installed release needs no installer metadata.
        const tag = await this.getLatestTagName(cancellation);
        const version = semver.valid(tag);
        if (!version || semver.prerelease(version)) {
          throw new Error('The release host did not return a valid stable EterX version.');
        }
        if (!semver.gt(version, this.updater.currentVersion)) {
          return { tag, version, files: [] };
        }

        const platform = this.runtimeOptions.platform;
        const architecture = process.arch;
        const os = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
        const extension = platform === 'win32' ? 'exe' : platform === 'darwin' ? 'zip' : 'AppImage';
        const architectures = platform === 'linux' && architecture === 'x64'
          ? ['x64', 'x86_64']
          : platform === 'darwin' ? [architecture, 'universal'] : [architecture];
        const names = architectures.map(arch => `EterX-${version}-${os}-${arch}.${extension}`);
        const channelFile = `${this.getDefaultChannelName()}.yml`;
        const assetUrl = name => new URL(this.getBaseDownloadPath(tag, name), this.baseUrl);
        const assetName = value => {
          if (typeof value !== 'string') return null;
          if (names.includes(value)) return value;
          try {
            // Accept relative and absolute metadata URLs only when they point
            // at this exact release and platform. Keep resolution tag-pinned.
            const url = new URL(value, assetUrl(''));
            return names.find(name => assetUrl(name).href === url.href) || null;
          } catch {
            return null;
          }
        };
        const verifiedFile = file => {
          const url = assetName(file?.url);
          if (!url) return null;
          const sha512 = typeof file.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
            ? file.sha512
            : typeof file.sha512 === 'string' && /^[a-f0-9]{128}$/i.test(file.sha512)
              ? Buffer.from(file.sha512, 'hex').toString('base64')
              : undefined;
          const sha2 = typeof file.sha2 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha2)
            ? file.sha2.toLowerCase()
            : undefined;
          if (!sha512 && !sha2) throw pending();
          // electron-updater prefers SHA-512 when present; never pass an invalid
          // value that would mask a valid SHA-256 checksum and break downloads.
          return { ...file, url, sha512, sha2 };
        };
        const pending = () => Object.assign(
          new Error(`EterX ${version} is published, but its verified ${os} ${architecture} update package is not ready yet. EterX will try again automatically.`),
          { code: 'ERR_ETERX_RELEASE_PENDING' },
        );
        let metadata;
        try {
          const raw = await this.httpRequest(assetUrl(channelFile), { Accept: 'application/octet-stream' }, cancellation);
          metadata = parseUpdateInfo(raw, channelFile, assetUrl(channelFile).href);
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
            throw new Error('The release host returned invalid update metadata. Try again shortly.');
          }
        } catch (error) {
          // Only a missing channel file allows the official checksum fallback.
          // Network failures and malformed metadata must not masquerade as current.
          if (error?.statusCode !== 404) throw error;
        }

        if (metadata) {
          if (!semver.valid(metadata.version) || !semver.eq(metadata.version, version)) throw pending();
          const candidates = getFileList(metadata).map(verifiedFile).filter(Boolean);
          const file = names.map(name => candidates.find(candidate => candidate.url === name)).find(Boolean);
          if (!file) throw pending();
          this.updater.disableDifferentialDownload = !file.sha512;
          return await this.withReleaseHighlights({ ...metadata, tag, version, files: [file], path: file.url, sha512: file.sha512, sha2: file.sha2 }, cancellation);
        }

        // Older releases may have native installers and the official manifest
        // without latest*.yml. A SHA-256 entry still permits a verified full
        // download; never synthesize availability from an unchecked filename.
        let manifest;
        try {
          manifest = await this.httpRequest(assetUrl('SHA256SUMS.txt'), { Accept: 'text/plain' }, cancellation);
        } catch (error) {
          if (error?.statusCode === 404) throw pending();
          throw error;
        }
        const files = String(manifest || '').split(/\r?\n/).flatMap(line => {
          const match = /^([a-f0-9]{64})\s+\*?(?:\.\/)?([^/\\]+)$/i.exec(line.trim());
          return match && names.includes(match[2]) ? [{ url: match[2], sha2: match[1].toLowerCase() }] : [];
        });
        // Some older releases publish both x64 spellings. Pick the preferred
        // verified artifact instead of rejecting a release containing both.
        const file = names.map(name => files.find(candidate => candidate.url === name)).find(Boolean);
        if (!file || files.some(candidate => candidate.url === file.url && candidate.sha2 !== file.sha2)) throw pending();
        this.updater.disableDifferentialDownload = true;
        return await this.withReleaseHighlights({ tag, version, files: [file], releaseName: `EterX ${version}` }, cancellation);
      } catch (error) {
        if (cancellation.cancelled) {
          throw Object.assign(new Error('The release host took too long to respond. Try again shortly.'), { code: 'ETIMEDOUT' });
        }
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    }
  };
}

module.exports = { createDesktopUpdateProvider };
