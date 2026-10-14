# Encrypt credentials for the current user in newly created volatile keys.
# Console streams here are private parent/child pipes, never terminal output.
param(
  [Parameter(Mandatory = $true)][ValidateSet('Read', 'Write', 'Clear')][string]$Action,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$Scope
)
$ErrorActionPreference = 'Stop'
$cacheRoot = $null
$cacheMutex = $null
$ownsMutex = $false
$plainBytes = $null
$cipherBytes = $null
$cacheInput = $null
$cacheValues = $null
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  Add-Type -AssemblyName System.Security
  $cachePath = 'Software\EasyECADDownloader\HeadlessQaSessions\' + $Scope
  $cacheMutex = [System.Threading.Mutex]::new($false, ('Local\EasyEcadQaSession_' + $Scope))
  try { $ownsMutex = $cacheMutex.WaitOne(5000) }
  catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { throw 'Cache is busy' }
  $cacheRoot = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($cachePath,
    [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Microsoft.Win32.RegistryOptions]::Volatile)
  $activeName = [string]$cacheRoot.GetValue('Active', '')
  if ($activeName -and $activeName -notmatch '^[a-f0-9]{32}$') { throw 'Invalid cache index' }
  $entropy = [System.Text.Encoding]::UTF8.GetBytes('EasyECADDownloader.HeadlessQA.v1:' + $Scope)
  if ($Action -eq 'Write') {
    $cacheInput = [Console]::In.ReadToEnd()
    if ($cacheInput.Length -gt 65536) { throw 'Invalid credential length' }
    $cacheValues = $cacheInput | ConvertFrom-Json
    if ($cacheValues.username -isnot [string] -or $cacheValues.password -isnot [string] -or
        -not $cacheValues.username -or -not $cacheValues.password -or
        $cacheValues.username.Length -gt 4096 -or $cacheValues.password.Length -gt 4096 -or
        $cacheValues.username.Contains(':')) { throw 'Invalid credentials' }
    $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($cacheInput)
    $cipherBytes = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy,
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    # A fresh GUID prevents an existing nonvolatile key from ignoring Volatile.
    do {
      $newName = [Guid]::NewGuid().ToString('N')
      $existing = $cacheRoot.OpenSubKey($newName)
      if ($existing) { $existing.Dispose() }
    } while ($existing)
    $secretKey = $cacheRoot.CreateSubKey($newName,
      [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Microsoft.Win32.RegistryOptions]::Volatile)
    try { $secretKey.SetValue('Payload', $cipherBytes, [Microsoft.Win32.RegistryValueKind]::Binary) }
    finally { $secretKey.Dispose() }
    $cacheRoot.SetValue('Active', $newName, [Microsoft.Win32.RegistryValueKind]::String)
    if ($activeName) { $cacheRoot.DeleteSubKeyTree($activeName, $false) }
    [Console]::Out.Write('{"configured":true}')
  } elseif ($Action -eq 'Read') {
    $secretKey = if ($activeName) { $cacheRoot.OpenSubKey($activeName) } else { $null }
    if (-not $secretKey) { [Console]::Out.Write('null') }
    else {
      try { $cipherBytes = $secretKey.GetValue('Payload') }
      finally { $secretKey.Dispose() }
      if ($cipherBytes -isnot [byte[]]) { throw 'Invalid encrypted cache' }
      $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($cipherBytes, $entropy,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plainBytes))
    }
  } else {
    $cacheRoot.Dispose()
    $cacheRoot = $null
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($cachePath, $false)
    [Console]::Out.Write('{"cleared":true}')
  }
} catch {
  [Console]::Error.WriteLine('Windows memory-only SamacSys cache operation failed.')
  exit 1
} finally {
  if ($plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($cipherBytes) { [Array]::Clear($cipherBytes, 0, $cipherBytes.Length) }
  $cacheInput = $null
  $cacheValues = $null
  if ($cacheRoot) { $cacheRoot.Dispose() }
  if ($ownsMutex) { $cacheMutex.ReleaseMutex() }
  if ($cacheMutex) { $cacheMutex.Dispose() }
}
