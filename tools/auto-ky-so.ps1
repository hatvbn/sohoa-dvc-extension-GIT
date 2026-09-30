<#
    HaTools - Tu bam nut "Ky so" tren cong cu ky so VGCA
    ----------------------------------------------------
    Dung kem extension HaTools DVCBacNinh: extension mo cua so ky cho tung ho so,
    script nay bam nut "Ky so" giup ban.

    Cach dung:
        .\auto-ky-so.ps1 -DryRun     # chay thu: chi bao thay gi, KHONG bam
        .\auto-ky-so.ps1             # chay that
        .\auto-ky-so.ps1 -MaxMinutes 30
        .\auto-ky-so.ps1 -CloseStale # dong cac cua so ky con treo tu truoc

    Dung script: bam Ctrl+C trong cua so PowerShell nay.

    CANH BAO ve -CloseStale:
      Neu cua so ky bi treo/an, cac lan bam sau se KHONG mo duoc cua so nao.
      -CloseStale dong chung di, NHUNG viec dong nay lam dut ket noi cua trang
      voi phan mem ky (Console bao "Connection is closed"). Sau khi -CloseStale
      phai TAI LAI TRANG DVC roi moi chay tiep.

    Ghi chu ky thuat:
      - Cua so ky co luc khong duoc UIAutomation liet ke, va cac nut ben trong
        KHONG doc duoc qua UIAutomation. Vi vay script dung Win32 thuan:
        EnumWindows tim cua so, EnumChildWindows tim nut, BM_CLICK de bam.
      - Nut can bam la control lop "...BUTTON..." co chu dung bang "Ky so".
        Cac chu khac ("Dong", "Cau hinh", "SAO Y", "KY SO BAN SAO...") khong khop.
#>

[CmdletBinding()]
param(
    [switch] $DryRun,
    [switch] $CloseStale,
    [int]    $IntervalMs = 400,
    [int]    $MaxMinutes = 0,
    [int]    $CooldownSeconds = 8,

    # Tu thoat sau bao nhieu phut khong thay cua so ky nao (0 = khong tu thoat).
    # Nho vay script khong nam chay mai sau khi ban so hoa xong.
    [int]    $IdleMinutes = 5,
    [string] $WindowPattern = 'K.\s*s.\s*c.ng v.n|C.NG C. K. S.',
    [string] $ButtonPattern = '^K.\s*s.$',
    [string] $LogPath
)

$ErrorActionPreference = 'Stop'

if (-not $LogPath) {
    $here = $PSScriptRoot
    if (-not $here -and $PSCommandPath) { $here = Split-Path -Parent $PSCommandPath }
    if (-not $here) { $here = (Get-Location).Path }
    $LogPath = Join-Path $here 'auto-ky-so.log'
}

$helper = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class HaToolsWin {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

    delegate bool EnumProc(IntPtr h, IntPtr p);

    public class Ctrl {
        public IntPtr Handle;
        public string Text;
        public string Class;
        public bool Visible;
        public bool Enabled;
    }

    public static string Text(IntPtr h) {
        int n = GetWindowTextLength(h);
        if (n <= 0) return "";
        var sb = new StringBuilder(n + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string Cls(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        return sb.ToString();
    }

    public static List<Ctrl> TopWindows() {
        var list = new List<Ctrl>();
        EnumWindows((h, p) => {
            string t = Text(h);
            if (t.Length > 0) {
                list.Add(new Ctrl { Handle = h, Text = t, Class = Cls(h),
                                    Visible = IsWindowVisible(h), Enabled = IsWindowEnabled(h) });
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static List<Ctrl> Children(IntPtr parent) {
        var list = new List<Ctrl>();
        EnumChildWindows(parent, (h, p) => {
            list.Add(new Ctrl { Handle = h, Text = Text(h), Class = Cls(h),
                                Visible = IsWindowVisible(h), Enabled = IsWindowEnabled(h) });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // BM_CLICK = 0x00F5
    public static void Click(IntPtr h) { SendMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
    // WM_CLOSE = 0x0010
    public static void Close(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
"@
if (-not ([System.Management.Automation.PSTypeName]'HaToolsWin').Type) {
    Add-Type -TypeDefinition $helper -Language CSharp
}

function Write-Log {
    param([string] $Message, [string] $Level = 'INFO')
    $line = '[{0}] {1,-5} {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Message
    switch ($Level) {
        'OK'   { Write-Host $line -ForegroundColor Green }
        'WARN' { Write-Host $line -ForegroundColor Yellow }
        'ERR'  { Write-Host $line -ForegroundColor Red }
        default { Write-Host $line }
    }
    try { Add-Content -Path $LogPath -Value $line -Encoding utf8 } catch { }
}

function Get-SignWindows {
    $res = @()
    foreach ($w in [HaToolsWin]::TopWindows()) {
        if ($w.Text -match $WindowPattern) { $res += $w }
    }
    return $res
}

function Get-SignButton {
    param([IntPtr] $Handle)
    foreach ($c in [HaToolsWin]::Children($Handle)) {
        if ($c.Class -notmatch 'BUTTON') { continue }
        $t = ($c.Text).Trim()
        if ($t -match $ButtonPattern) { return $c }
    }
    return $null
}

if ($CloseStale) {
    $stale = Get-SignWindows
    Write-Log ("Dong {0} cua so ky con treo." -f $stale.Count) 'WARN'
    foreach ($w in $stale) { [HaToolsWin]::Close($w.Handle) }
    Start-Sleep -Seconds 2
    Write-Log ("Con lai: {0}" -f (Get-SignWindows).Count)
    Write-Log 'Nho TAI LAI TRANG DVC truoc khi chay tiep.' 'WARN'
    return
}

# Chi cho phep mot ban chay cung luc (Chrome co the goi nhieu lan).
$mutex = New-Object System.Threading.Mutex($false, 'Global\HaToolsAutoKySo')
$coQuyen = $false
try { $coQuyen = $mutex.WaitOne(0) } catch { $coQuyen = $true }
if (-not $coQuyen) {
    Write-Log 'Da co mot ban dang chay - thoat.' 'WARN'
    return
}

$mode = if ($DryRun) { 'CHAY THU (khong bam)' } else { 'CHAY THAT' }
Write-Log ("Bat dau. Che do: {0}" -f $mode)
Write-Log ("Nhat ky: {0}" -f $LogPath)
Write-Log ('Mau cua so: "{0}" | mau nut: "{1}"' -f $WindowPattern, $ButtonPattern)
Write-Log 'Bam Ctrl+C de dung.'

$clicked = @{}
$deadline = if ($MaxMinutes -gt 0) { (Get-Date).AddMinutes($MaxMinutes) } else { $null }
$count = 0
$lanThayCuoi = Get-Date

if ($IdleMinutes -gt 0) {
    Write-Log ("Tu thoat neu {0} phut khong thay cua so ky nao." -f $IdleMinutes)
}

while ($true) {
    if ($deadline -and (Get-Date) -gt $deadline) {
        Write-Log ("Het {0} phut, dung." -f $MaxMinutes) 'WARN'
        break
    }

    $dsCuaSo = @(Get-SignWindows)
    if ($dsCuaSo.Count -gt 0) {
        $lanThayCuoi = Get-Date
    } elseif ($IdleMinutes -gt 0 -and ((Get-Date) - $lanThayCuoi).TotalMinutes -gt $IdleMinutes) {
        Write-Log ("{0} phut khong co cua so ky nao - tu thoat." -f $IdleMinutes) 'WARN'
        break
    }

    foreach ($w in $dsCuaSo) {
        $key = [string] $w.Handle
        if ($clicked.ContainsKey($key)) {
            if (((Get-Date) - $clicked[$key]).TotalSeconds -lt $CooldownSeconds) { continue }
        }

        $short = $w.Text
        if ($short.Length -gt 70) { $short = $short.Substring(0, 70) + '...' }

        $btn = Get-SignButton -Handle $w.Handle

        if ($DryRun) {
            $names = @()
            foreach ($c in [HaToolsWin]::Children($w.Handle)) {
                if ($c.Class -match 'BUTTON' -and ($c.Text).Trim()) { $names += ($c.Text).Trim() }
            }
            Write-Log ("[CHAY THU] Cua so: {0}" -f $short) 'WARN'
            Write-Log ("[CHAY THU] Cac nut: {0}" -f ($names -join ' | ')) 'WARN'
            if ($btn) {
                Write-Log ("[CHAY THU] Se bam: '{0}' (bat={1})" -f ($btn.Text).Trim(), $btn.Enabled) 'OK'
            } else {
                Write-Log '[CHAY THU] KHONG thay nut nao khop mau.' 'ERR'
            }
            $clicked[$key] = Get-Date
            continue
        }

        if (-not $btn) { continue }
        if (-not $btn.Enabled) { continue }

        try {
            [HaToolsWin]::Click($btn.Handle)
            $count++
            $clicked[$key] = Get-Date
            Write-Log ("Da bam '{0}' (lan {1}) - {2}" -f ($btn.Text).Trim(), $count, $short) 'OK'
        } catch {
            Write-Log ("Loi khi bam: {0}" -f $_.Exception.Message) 'ERR'
            $clicked[$key] = Get-Date
        }
    }

    foreach ($k in @($clicked.Keys)) {
        if (((Get-Date) - $clicked[$k]).TotalMinutes -gt 10) { $clicked.Remove($k) | Out-Null }
    }

    Start-Sleep -Milliseconds $IntervalMs
}

Write-Log ("Ket thuc. Tong so lan bam: {0}" -f $count)
try { $mutex.ReleaseMutex() } catch { }
