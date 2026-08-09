# migrate-appdata.ps1
# Migrates Giano Reader app data from the old identifier path to the new one.
# Run this ONCE after updating to the new identifier.
#
# Usage: powershell -ExecutionPolicy Bypass -File migrate-appdata.ps1
#
# NOTE: EBWebView (WebView2 profile) is NOT migrated — it contains path-bound
# data that becomes corrupt if moved. It will be recreated automatically.

$oldPath = "$env:LOCALAPPDATA\com.bolzonella.giano-reader"
$newPath = "$env:LOCALAPPDATA\giano-reader"

# Folders to skip (they are recreated automatically and break if moved)
$skipFolders = @("EBWebView", "giano-web.db")

if (-not (Test-Path $oldPath)) {
    Write-Host "Nothing to migrate: old path does not exist ($oldPath)"
    exit 0
}

# Ensure new path exists
if (-not (Test-Path $newPath)) {
    New-Item -ItemType Directory -Path $newPath -Force | Out-Null
}

Write-Host "Migrating data from $oldPath to $newPath ..."

Get-ChildItem -Path $oldPath | ForEach-Object {
    if ($_.PSIsContainer -and $skipFolders -contains $_.Name) {
        Write-Host "  Skipping $($_.Name) (will be recreated automatically)"
        return
    }

    $dest = Join-Path $newPath $_.Name

    if (-not (Test-Path $dest)) {
        Move-Item -Path $_.FullName -Destination $dest
        Write-Host "  Moved: $($_.Name)"
    } else {
        Write-Host "  Already exists, skipping: $($_.Name)"
    }
}

# Remove old directory if empty (or only contains skipped folders)
$remaining = Get-ChildItem -Path $oldPath -ErrorAction SilentlyContinue
if ($remaining.Count -eq 0 -or ($remaining | Where-Object { $skipFolders -notcontains $_.Name }).Count -eq 0) {
    Remove-Item -Path $oldPath -Recurse -Force
    Write-Host "Old path removed."
} else {
    Write-Host "Old path not removed (still contains files)."
}

Write-Host "Migration complete. You can now start Giano Reader."
