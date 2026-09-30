<#
    Dang ky / go dang ky native messaging host cho HaTools.
    Chi ghi vao HKCU (pham vi nguoi dung hien tai), khong dung toi HKLM.

        .\cai-dat.ps1            # dang ky
        .\cai-dat.ps1 -GoCaiDat  # go dang ky
#>
[CmdletBinding()]
param([switch] $GoCaiDat)

$hostName = 'com.hatools.autokyso'
$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$manifest = Join-Path $PSScriptRoot "$hostName.json"

if ($GoCaiDat) {
    if (Test-Path $key) {
        Remove-Item $key -Force
        "Da go khoa Registry: $key"
    } else {
        "Khong co khoa nao de go."
    }
    return
}

if (-not (Test-Path $manifest)) { throw "Khong thay file $manifest" }

$bat = Join-Path $PSScriptRoot 'launch-auto-ky-so.bat'
if (-not (Test-Path $bat)) { throw "Khong thay file $bat" }

New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifest
"Da dang ky native messaging host."
"  Khoa    : $key"
"  Manifest: $manifest"
"  Chay    : $bat"
""
"Buoc tiep: vao chrome://extensions bam Tai lai (reload) tren HaTools DVCBacNinh."
