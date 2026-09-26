# Isolated native test helper. Holds the previous clipboard in memory and restores
# it when the controlling test closes stdin. Never writes clipboard data to disk.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$original = [Windows.Forms.DataObject]::new()
$previous = [Windows.Forms.Clipboard]::GetDataObject()
if ($previous) {
    foreach ($format in $previous.GetFormats($false)) {
        try { $original.SetData($format, $false, $previous.GetData($format, $false)) } catch { }
    }
}
$bitmap = $null
try {
    $bitmap = [Drawing.Bitmap]::FromFile($env:NOT_TEST_CLIPBOARD_IMAGE)
    [Windows.Forms.Clipboard]::SetImage($bitmap)
    [Console]::WriteLine('image-ready')
    if ([Console]::ReadLine() -eq 'files') {
        $paths = [Collections.Specialized.StringCollection]::new()
        [void]$paths.Add($env:NOT_TEST_CLIPBOARD_IMAGE)
        [Windows.Forms.Clipboard]::SetFileDropList($paths)
        [Console]::WriteLine('files-ready')
        [void][Console]::ReadLine()
    }
} finally {
    if ($previous) { [Windows.Forms.Clipboard]::SetDataObject($original, $true) }
    else { [Windows.Forms.Clipboard]::Clear() }
    if ($bitmap) { $bitmap.Dispose() }
}
