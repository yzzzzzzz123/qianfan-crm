[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$taskUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskPowerShell='C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe'
$taskSettings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$taskStart=New-ScheduledTaskAction -Execute $taskPowerShell -Argument ('-NoProfile -WindowStyle Hidden -File "'+(Join-Path $PSScriptRoot 'manage.ps1')+'" -Action Start')
$taskStartTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$taskBackup=New-ScheduledTaskAction -Execute $taskPowerShell -Argument ('-NoProfile -WindowStyle Hidden -File "'+(Join-Path $PSScriptRoot 'backup.ps1')+'"')
$taskBackupTrigger=New-ScheduledTaskTrigger -Daily -At '03:30'
$taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Qianfan-CRM-Production' -Action $taskStart -Trigger $taskStartTrigger -Settings $taskSettings -Principal $taskPrincipal -Description 'Start local production CRM with DingTalk login.' -Force | Out-Null
Register-ScheduledTask -TaskName 'Qianfan-CRM-Production-Backup' -Action $taskBackup -Trigger $taskBackupTrigger -Settings $taskSettings -Principal $taskPrincipal -Description 'Back up local production CRM database at 03:30.' -Force | Out-Null
Get-ScheduledTask -TaskName 'Qianfan-CRM-Production','Qianfan-CRM-Production-Backup' | Select-Object TaskName,State
