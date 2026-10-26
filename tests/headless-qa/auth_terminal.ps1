# A visible credential console is intentional. All browser QA windows continue
# to use their private desktop. The credential console owns its interactive streams.
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][string]$AuthScript,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
)
$ErrorActionPreference = 'Stop'
$terminal = $null
try {
    $node = (Get-Item -LiteralPath $NodePath).FullName
    $script = (Get-Item -LiteralPath $AuthScript).FullName
    $directory = (Get-Item -LiteralPath $WorkingDirectory).FullName
    Add-Type -TypeDefinition @'
using System;
using System.Threading.Tasks;
public static class QaCredentialControl {
    public static readonly Task<string> Closed = Task.Run(() => Console.ReadLine());
}
'@
    # ReadLine runs on a background thread: Console.In.ReadLineAsync can block
    # synchronously on Windows PowerShell's console reader.
    if ([QaCredentialControl]::Closed.IsCompleted) { exit 1 }
    $terminal = Start-Process -FilePath $node -ArgumentList ('"' + $script + '" --prompt') `
        -WorkingDirectory $directory -WindowStyle Normal -PassThru
    $null = $terminal.Handle
    while (-not $terminal.WaitForExit(100)) {
        if ([QaCredentialControl]::Closed.IsCompleted) {
            $terminal.Kill()
            $terminal.WaitForExit()
            exit 1
        }
    }
    $terminal.WaitForExit()
    if ($null -eq $terminal.ExitCode) { throw 'Credential console exit status is unavailable' }
    exit $terminal.ExitCode
} catch {
    [Console]::Error.WriteLine('QA credential console failed to open or complete.')
    exit 1
} finally {
    if ($null -ne $terminal) {
        if (-not $terminal.HasExited) {
            $terminal.Kill()
            $null = $terminal.WaitForExit(5000)
        }
        $terminal.Dispose()
    }
}
