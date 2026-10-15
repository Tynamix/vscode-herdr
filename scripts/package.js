'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
const xmlEscape = value => String(value).replace(/[<>&"']/g, character => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
})[character]);
const icon = manifest.icon ? `<Icon>extension/${xmlEscape(manifest.icon)}</Icon>` : '';
const iconAsset = manifest.icon ? `<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${xmlEscape(manifest.icon)}" Addressable="true"/>` : '';
// VSIX is a ZIP with an OPC content-types file, manifest, and extension/ folder.
const xml = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="${xmlEscape(manifest.name)}" Version="${xmlEscape(manifest.version)}" Publisher="${xmlEscape(manifest.publisher)}"/><DisplayName>${xmlEscape(manifest.displayName)}</DisplayName><Description xml:space="preserve">${xmlEscape(manifest.description)}</Description>${icon}<License>extension/LICENSE</License><Tags>${xmlEscape((manifest.keywords || []).join(','))}</Tags><Categories>${xmlEscape(manifest.categories.join(','))}</Categories><GalleryFlags>${manifest.preview ? 'Preview' : 'Public'}</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(manifest.engines.vscode)}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/></Properties></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>${iconAsset}</Assets>
</PackageManifest>`;
const contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="mjs" ContentType="application/javascript"/><Default Extension="css" ContentType="text/css"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>';
const vsixPath = path.join(output, `herdr-workbench-${manifest.version}.vsix`);
execFileSync('python3', ['-c', `import sys, zipfile, pathlib
root, target = pathlib.Path(sys.argv[1]), sys.argv[2]
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('extension.vsixmanifest', sys.argv[3])
    archive.writestr('[Content_Types].xml', sys.argv[4])
    for name in ('package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'SUPPORT.md', 'src', 'media', 'integrations', 'docs'):
        item = root / name
        for file in sorted(item.rglob('*')) if item.is_dir() else [item]:
            if not file.is_file(): continue
            relative = str(file.relative_to(root))
            if file.parent == root / 'media' and file.suffix == '.png' and relative != sys.argv[5]: continue
            archive.write(file, 'extension/' + relative)
`, root, vsixPath, xml, contentTypes, manifest.icon || ''], { stdio: 'inherit' });
console.log(vsixPath);
