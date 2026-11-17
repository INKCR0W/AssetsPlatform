[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Archive,

    [Parameter(Mandatory)]
    [string] $UnityEditor,

    [ValidatePattern('^\d+\.\d+\.\d+[abfp]\d+$')]
    [string] $UnityVersion = '2022.3.62f3',

    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $GltfFastVersion = '6.14.1',

    [string] $ScratchRoot = [IO.Path]::GetTempPath()
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$editorPath = (Resolve-Path -LiteralPath $UnityEditor).Path
$scratchPath = (Resolve-Path -LiteralPath $ScratchRoot).Path
if (![IO.Directory]::Exists($scratchPath)) { throw 'ScratchRoot must be an existing directory.' }
$projectDir = Join-Path $scratchPath ('assets-unity-verify-' + [guid]::NewGuid().ToString('N'))
$importDir = Join-Path $projectDir 'Assets/Imported'
$settingsDir = Join-Path $projectDir 'ProjectSettings'
$packagesDir = Join-Path $projectDir 'Packages'
$scriptsDir = Join-Path $projectDir 'Assets/Editor'
$logPath = Join-Path $projectDir 'Editor.log'

New-Item -ItemType Directory -Path $importDir,$settingsDir,$packagesDir,$scriptsDir | Out-Null
Set-Content -LiteralPath (Join-Path $settingsDir 'ProjectVersion.txt') -Value "m_EditorVersion: $UnityVersion" -Encoding ascii
$manifest = @{
    dependencies = @{
        'com.unity.cloud.gltfast' = $GltfFastVersion
        'com.unity.modules.animation' = '1.0.0'
        'com.unity.modules.imageconversion' = '1.0.0'
        'com.unity.modules.unitywebrequesttexture' = '1.0.0'
    }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $packagesDir 'manifest.json') -Encoding ascii
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'unity/VerifyAssetImport.cs') -Destination $scriptsDir
$importerPath = Join-Path $PSScriptRoot 'unity/AssetsPlatformWorkbenchImporter.cs'
Copy-Item -LiteralPath $importerPath -Destination $scriptsDir

# Stage only model and configuration files, preserving the configuration directories.
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
$modelCount = 0
try {
    foreach ($entry in $zip.Entries) {
        $path = $entry.FullName.Replace('\','/')
        $isModel = [IO.Path]::GetExtension($path) -ieq '.glb'
        if (!$isModel -and [IO.Path]::GetFileName($path) -cne 'asset.json') { continue }
        $segments = $path.Split('/')
        if ($segments | Where-Object { $_ -eq '' -or $_ -match '[:*?"<>|\x00-\x1f]|[. ]$' }) {
            throw "Unsupported path in archive: $path"
        }
        $target = [IO.Path]::GetFullPath((Join-Path $importDir $path))
        if (!$target.StartsWith("$importDir$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
            throw "Model path escaped the import directory: $path"
        }
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target)
        if ($isModel) { $modelCount++ }
    }
} finally {
    $zip.Dispose()
}
if ($modelCount -eq 0) { throw 'This archive contains no GLB models.' }

Write-Output "Unity verification project: $projectDir"
$arguments = @('-batchmode', '-nographics', '-quit', '-projectPath', "`"$projectDir`"", '-logFile', "`"$logPath`"",
    '-executeMethod', 'AssetsPlatform.Tools.VerifyAssetImport.Run')
$process = Start-Process -FilePath $editorPath -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "Unity exited with code $($process.ExitCode). See $logPath" }
$results = @(Select-String -LiteralPath $logPath -Pattern '^ASSET_IMPORT_(MODEL|PASS) ' | ForEach-Object Line)
if ($results.Count -ne ($modelCount + 1) -or $results[-1] -ne "ASSET_IMPORT_PASS $modelCount") {
    throw "Unity did not verify every model. See $logPath"
}
$results
