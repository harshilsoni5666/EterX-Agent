const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function spawnInstaller(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function launchWindowsUpdateInstaller(updater, resourcesPath) {
  const installerPath = updater.downloadedUpdateHelper?.file || updater.installerPath;
  if (!installerPath) throw new Error('The downloaded Windows installer is no longer available.');
  // Assisted NSIS installers only honor --force-run during a silent install.
  // Without /S an update opens the setup wizard and runAfterFinish=false can
  // leave EterX closed after installation. Keep the first-install UI separate.
  const args = ['--updated', '/S', '--force-run'];
  const packageFile = updater.downloadedUpdateHelper?.packageFile;
  if (packageFile) args.push(`--package-file=${packageFile}`);
  // NSIS requires /D to be the final argument, including when the path has spaces.
  if (updater.installDirectory) args.push(`/D=${updater.installDirectory}`);
  const elevate = () => spawnInstaller(path.join(resourcesPath, 'elevate.exe'), [installerPath, ...args]);
  if (updater.downloadedUpdateHelper?.downloadedFileInfo?.isAdminRightsRequired) {
    return elevate();
  }
  try {
    await spawnInstaller(installerPath, args);
  } catch (error) {
    if (!['EACCES', 'EPERM', 'UNKNOWN'].includes(error?.code)) throw error;
    await elevate();
  }
}

async function prepareAppImageUpdate(archivePath, appImagePath) {
  if (typeof appImagePath !== 'string' || !path.isAbsolute(appImagePath)) {
    throw new Error('The installed AppImage path is unavailable. Reopen the official AppImage and try again.');
  }
  // Resolve symlinks without replacing the user's launcher or changing its name.
  const targetPath = await fs.promises.realpath(appImagePath);
  const targetStat = await fs.promises.stat(targetPath);
  if (!targetStat.isFile()) throw new Error('The installed AppImage is not a regular file.');
  const parent = path.dirname(targetPath);
  await fs.promises.access(parent, fs.constants.W_OK | fs.constants.X_OK);
  const transactionRoot = await fs.promises.mkdtemp(path.join(parent, '.eterx-update-'));
  const prepared = {
    targetPath,
    transactionRoot,
    stagingPath: path.join(transactionRoot, 'next.AppImage'),
    previousPath: path.join(transactionRoot, 'previous.AppImage'),
    replaced: false,
  };
  try {
    // Copy across filesystems before touching the running image. Disk-full and
    // permissions failures leave the installed application intact.
    await fs.promises.copyFile(archivePath, prepared.stagingPath, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(prepared.stagingPath, (targetStat.mode & 0o777) | 0o700);
    try {
      await fs.promises.link(targetPath, prepared.previousPath);
    } catch {
      // Removable filesystems may not support hard links.
      await fs.promises.copyFile(targetPath, prepared.previousPath, fs.constants.COPYFILE_EXCL);
    }
    return prepared;
  } catch (error) {
    await discardAppImageUpdate(prepared).catch(() => {});
    throw error;
  }
}

async function activateAppImageUpdate(prepared) {
  // Both paths are on the installation filesystem: POSIX rename replaces the
  // directory entry atomically, without unlinking the working image first.
  await fs.promises.rename(prepared.stagingPath, prepared.targetPath);
  prepared.replaced = true;
}

async function discardAppImageUpdate(prepared, rollback = false) {
  if (!prepared) return;
  // This can also be called from a receipt read after restarting. Only remove
  // our own transaction directory beside this exact AppImage, never a launcher
  // directory or an arbitrary path from a damaged receipt.
  const { targetPath, transactionRoot, stagingPath, previousPath } = prepared;
  if (![targetPath, transactionRoot, stagingPath, previousPath].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
    path.dirname(transactionRoot) !== path.dirname(targetPath) ||
    !path.basename(transactionRoot).startsWith('.eterx-update-') ||
    stagingPath !== path.join(transactionRoot, 'next.AppImage') ||
    previousPath !== path.join(transactionRoot, 'previous.AppImage')) {
    throw new Error('The AppImage update recovery paths are invalid.');
  }
  try {
    const transactionStat = await fs.promises.lstat(transactionRoot);
    if (!transactionStat.isDirectory() || transactionStat.isSymbolicLink()) {
      throw new Error('The AppImage update recovery directory is invalid.');
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !rollback) return;
    throw error;
  }
  if (rollback && prepared.replaced) {
    // If restoring fails, retain the backup for recovery instead of deleting it.
    await fs.promises.rename(prepared.previousPath, prepared.targetPath);
    prepared.replaced = false;
  }
  await fs.promises.rm(prepared.transactionRoot, { recursive: true, force: true });
}

module.exports = { launchWindowsUpdateInstaller, prepareAppImageUpdate, activateAppImageUpdate, discardAppImageUpdate };
