[CmdletBinding(PositionalBinding=$false)]
param(
  [string]$ConfigPath='',
  [switch]$FromStdin,
  [switch]$Replace
)
$ErrorActionPreference='Stop'
$plainBytes=$null
$secretPointer=[IntPtr]::Zero
$temporary=$null
try {
  if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath=Join-Path (Split-Path -Parent $PSScriptRoot) '.private\company-profile.json' }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'windows-required' }
  $destination=[IO.Path]::GetFullPath($ConfigPath)
  $directory=[IO.Path]::GetDirectoryName($destination)
  if ((Test-Path -LiteralPath $destination) -and -not $Replace) { throw 'already-exists' }
  if ($FromStdin) {
    if (-not [Console]::IsInputRedirected) { throw 'stdin-must-be-redirected' }
    $key=[Console]::In.ReadToEnd().Trim()
  } else {
    $secure=Read-Host 'QCC MCP API Key (hidden)' -AsSecureString
    $secretPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $key=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
  }
  if ($key -notmatch '^[!-~]{8,4096}$') { throw 'invalid-key' }
  Add-Type -AssemblyName System.Security
  $plainBytes=[Text.Encoding]::UTF8.GetBytes($key)
  $cipher=[Security.Cryptography.ProtectedData]::Protect($plainBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $key=$null
  $profile=@{version=1;provider='qcc-mcp';protection='dpapi-current-user';protected_key=[Convert]::ToBase64String($cipher)}
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe-directory' }
  if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe-file' }
  $temporary=Join-Path $directory ('.company-profile-'+[Guid]::NewGuid().ToString('N')+'.tmp')
  $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  $stream.Dispose()
  $acl=New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true,$false)
  $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach ($sid in @($currentSid,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))) {
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $temporary -AclObject $acl
  [IO.File]::WriteAllText($temporary,($profile | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding $false))
  if (Test-Path -LiteralPath $destination) {
    if (-not $Replace) { throw 'already-exists' }
    $targetAcl=New-Object Security.AccessControl.FileSecurity
    $targetAcl.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access)
    [IO.File]::SetAccessControl($destination,$targetAcl)
    [IO.File]::Replace($temporary,$destination,[NullString]::Value)
  } else { [IO.File]::Move($temporary,$destination) }
  $temporary=$null
  [Console]::Out.WriteLine('{"saved":true,"provider":"qcc-mcp","protection":"dpapi-current-user"}')
} catch {
  [Console]::Error.WriteLine('Credential was not saved. Check input, file permissions, and use -Replace only for an intended update.')
  [Console]::Error.WriteLine('Failure code: '+$_.Exception.GetType().Name+'/'+$_.Exception.HResult+'; line '+$_.InvocationInfo.ScriptLineNumber)
  exit 1
} finally {
  $key=$null
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes,0,$plainBytes.Length) }
  if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
  if ($null -ne $secure) { $secure.Dispose() }
  if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
}
