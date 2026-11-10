param([Parameter(Mandatory=$true)][string]$ConfigPath,[ValidateSet('protected_key','protected_search_key')][string]$Field='protected_key')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$profile=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$encrypted=[Convert]::FromBase64String($profile.$Field)
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain)) }
finally { [Array]::Clear($plain,0,$plain.Length) }
