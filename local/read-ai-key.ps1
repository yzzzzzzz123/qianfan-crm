param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$profile=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$encrypted=[Convert]::FromBase64String($profile.protected_key)
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain)) }
finally { [Array]::Clear($plain,0,$plain.Length) }
