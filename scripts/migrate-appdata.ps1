# migrate-appdata.ps1
# Migrates Giano Reader app data from the old identifier path to the new one.
# Run this ONCE after updating to the new identifier.
#
# Usage: powershell -ExecutionPolicy Bypass -File migrate-appdata.ps1

$oldPath = "$env:LOCALAPPDATA\com.bolzonella.giano-reader"
$newPath = "$env:LOCALAPPDATA\giano-reader"

if (-not (Test-Path $oldPath)) {
    Write-Host "Nothing to migrate: old path does not exist ($oldPath)"
    exit 0
}

if (Test-Path $newPath) {
    Write-Host "New path already exists ($newPath)."
    Write-Host "Merging files from old path (existing files in new path will NOT be overwritten)..."
    
    Get-ChildItem -Path $oldPath -Recurse | ForEach-Object {
        $dest = $_.FullName.Replace($oldPath, $newPath)
        if ($_.PSIsContainer) {
            if (-not (Test-Path $dest)) {
                New-Item -ItemType Directory -Path $dest -Force | Out-Null
            }
        } else {
            if (-not (Test-Path $dest)) {
                Copy-Item -Path $_.FullName -Destination $dest -Force
            }
        }
    }
} else {
    Write-Host "Moving $oldPath -> $newPath"
    Move-Item -Path $oldPath -Destination $newPath
}

# Remove old directory
if (Test-Path $oldPath) {
    Remove-Item -Path $oldPath -Recurse -Force
    Write-Host "Old path removed."
}

Write-Host "Migration complete."
