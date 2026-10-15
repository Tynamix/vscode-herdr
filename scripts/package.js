'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
// VSIX is a ZIP with an OPC content-types file, manifest, and extension/ folder.
const xml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}"/><DisplayName>${manifest.displayName}</DisplayName><Description xml:space="preserve">${manifest.description}</Description><Tags>worktrees,sessions,agents</Tags><Categories>Other</Categories><GalleryFlags>Preview</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>`;
const contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="mjs" ContentType="application/javascript"/><Default Extension="css" ContentType="text/css"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>';
const vsixPath = path.join(output, `herdr-workbench-${manifest.version}.vsix`);
execFileSync('python3', ['-c', `import sys, zipfile, pathlib
root, target = pathlib.Path(sys.argv[1]), sys.argv[2]
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', sys.argv[3])
    archive.writestr('[Content_Types].xml', sys.argv[4])
    for name in ('package.json', 'README.md', 'src', 'media', 'integrations'):
        item = root / name
        for file in sorted(item.rglob('*')) if item.is_dir() else [item]:
            if file.is_file(): archive.write(file, 'extension/' + str(file.relative_to(root)))
`, root, vsixPath, xml, contentTypes], { stdio: 'inherit' });
console.log(vsixPath);
