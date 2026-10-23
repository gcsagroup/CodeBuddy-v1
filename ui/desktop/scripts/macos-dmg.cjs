'use strict';
const fs = require('node:fs');
const path = require('node:path');

const layoutScript = `on run argv
  set mountPath to item 1 of argv
  set appName to item 2 of argv
  set diskFolder to POSIX file mountPath as alias
  tell application "Finder"
    set installWindow to make new Finder window to diskFolder
    set current view of installWindow to icon view
    set toolbar visible of installWindow to false
    set statusbar visible of installWindow to false
    set bounds of installWindow to {160, 120, 800, 540}
    set options to icon view options of installWindow
    set arrangement of options to not arranged
    set icon size of options to 88
    set text size of options to 13
    set background picture of options to file ".background:background.tiff" of diskFolder
    set position of item appName of diskFolder to {168, 202}
    set position of item "Applications" of diskFolder to {472, 202}
    update diskFolder without registering applications
    delay 2
    close installWindow
  end tell
end run`;

function buildDmg({ app, dmg, build, run }) {
  const image = path.join(build, 'image');
  fs.mkdirSync(path.join(image, '.background'), { recursive: true });
  run('ditto', [app, path.join(image, path.basename(app))]);
  fs.symlinkSync('/Applications', path.join(image, 'Applications'));
  run('/usr/bin/swift', [path.join(__dirname, 'dmg-background.swift'), path.join(image, '.background/background.tiff')]);
  const writable = path.join(build, 'layout.dmg');
  const mount = path.join(build, 'mounted-image');
  fs.mkdirSync(mount);
  run('hdiutil', ['create', '-ov', '-format', 'UDRW', '-fs', 'HFS+', '-volname', 'CodeBuddy', '-srcfolder', image, writable]);
  let attached = false;
  try {
    run('hdiutil', ['attach', '-readwrite', '-noverify', '-nobrowse', '-mountpoint', mount, writable]);
    attached = true;
    run('/usr/bin/osascript', ['-e', layoutScript, mount, path.basename(app)]);
    if (!fs.existsSync(path.join(mount, '.DS_Store'))) throw new Error('Finder did not save the installation layout');
  } finally {
    if (attached) run('hdiutil', ['detach', mount]);
  }
  run('hdiutil', ['convert', writable, '-format', 'UDZO', '-ov', '-o', dmg]);
  run('hdiutil', ['verify', dmg]);
}
module.exports = { buildDmg };
