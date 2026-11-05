[CmdletBinding(PositionalBinding=$false)]
param(
  [string]$ConfigPath='',
  [switch]$InternalPipe
)
$ErrorActionPreference='Stop'
$plain=$null
try {
  if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath=Join-Path (Split-Path -Parent $PSScriptRoot) '.private\company-profile.json' }
  if (-not $InternalPipe -or -not [Console]::IsOutputRedirected) { throw 'internal-only' }
  Add-Type -AssemblyName System.Security
  $profile=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($profile.provider -ne 'qcc-mcp' -or $profile.protection -ne 'dpapi-current-user' -or $profile.PSObject.Properties.Name -contains 'apiKey') { throw 'invalid-config' }
  $encrypted=[Convert]::FromBase64String($profile.protected_key)
  $plain=[System.Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  # This stdout is consumed only by the parent Node process through a private pipe.
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
} catch {
  [Console]::Error.WriteLine('Unable to decrypt company profile credential for the current Windows user.')
  exit 1
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
}
