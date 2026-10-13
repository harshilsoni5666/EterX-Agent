const { createRequire } = require('module');

// Resolve against the updater's own dependency tree, including dependencies.asar.
// Keep downloads, checksum verification, and installation in electron-updater.
function createDesktopUpdateProvider(updaterEntry) {
  const updaterRequire = createRequire(updaterEntry);
  const { GitHubProvider } = updaterRequire('./providers/GitHubProvider');
  const { parseUpdateInfo, getFileList } = updaterRequire('./providers/Provider');
  const { CancellationToken } = updaterRequire('builder-util-runtime');
  const semver = updaterRequire('semver');

  return class DesktopUpdateProvider extends GitHubProvider {
    getBaseDownloadPath(tag, fileName) {
      return `${this.basePath}/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
    }

    createRequestOptions(url, headers) {
      return { ...super.createRequestOptions(url, headers), timeout: 20_000 };
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
        const architectures = platform === 'linux' && architecture === 'x64' ? ['x64', 'x86_64'] : [architecture];
        const names = architectures.map(arch => `EterX-${version}-${os}-${arch}.${extension}`);
        const channelFile = `${this.getDefaultChannelName()}.yml`;
        const assetUrl = name => new URL(this.getBaseDownloadPath(tag, name), this.baseUrl);
        const pending = () => Object.assign(
          new Error(`EterX ${version} is published, but its verified ${os} ${architecture} update package is not ready yet. EterX will try again automatically.`),
          { code: 'ERR_ETERX_RELEASE_PENDING' },
        );
        let metadata;
        try {
          const raw = await this.httpRequest(assetUrl(channelFile), { Accept: 'application/octet-stream' }, cancellation);
          metadata = parseUpdateInfo(raw, channelFile, assetUrl(channelFile).href);
        } catch (error) {
          // Only a missing channel file allows the official checksum fallback.
          // Network failures and malformed metadata must not masquerade as current.
          if (error?.statusCode !== 404) throw error;
        }

        if (metadata) {
          if (!semver.valid(metadata.version) || !semver.eq(metadata.version, version)) throw pending();
          const files = getFileList(metadata).filter(file => names.includes(file.url));
          if (!files.length || files.some(file => !(
            (typeof file.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) ||
            (typeof file.sha2 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha2))
          ))) throw pending();
          this.updater.disableDifferentialDownload = files.some(file => !file.sha512);
          return { ...metadata, tag, version, files };
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
        if (files.length !== 1) throw pending();
        this.updater.disableDifferentialDownload = true;
        return { tag, version, files, releaseName: `EterX ${version}` };
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
