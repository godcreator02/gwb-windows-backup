param(
  [Parameter(Mandatory)][string]$Restic,
  [string]$NewBaseline = (Join-Path $PSScriptRoot '..\..\plugins\windows-backup\config\restic-exclude.txt')
)
$ErrorActionPreference = 'Stop'

$samples = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'input\samples.txt') -Encoding utf8 |
  Where-Object { $_ -and -not $_.StartsWith('#') } |
  ForEach-Object { $expect, $path = $_ -split "`t", 2; [pscustomobject]@{ Expect = $expect; Path = $path } }

$work = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('exclude-rule-probe-' + [guid]::NewGuid().ToString('N').Substring(0, 8)))
$work = Get-Item -LiteralPath $work.FullName
$tree = Join-Path $work.FullName 'tree'
$repo = Join-Path $work.FullName 'repo'

function Invoke-DryRun([string]$excludeFile) {
  $output = & $Restic --repo $repo backup --dry-run -vv "--exclude-file=$excludeFile" $tree 2>&1
  if ($LASTEXITCODE -ne 0) { throw "restic 退出码 $LASTEXITCODE`n$($output -join "`n")" }
  $treePrefix = '/' + ($tree -replace ':', '' -replace '\\', '/') + '/'
  $keptPaths = foreach ($line in $output) {
    if ("$line" -match '^new\s+(\S.*?), saved in' -and -not $Matches[1].EndsWith('/')) { $Matches[1].Substring($treePrefix.Length) }
  }
  foreach ($sample in $samples) {
    $actual = if ($keptPaths -contains $sample.Path) { 'keep' } else { 'drop' }
    [pscustomobject]@{ Expect = $sample.Expect; Actual = $actual; Match = ($actual -eq $sample.Expect); Path = $sample.Path }
  }
}

function Format-Run([string]$title, [object[]]$rows) {
  $mismatches = @($rows | Where-Object { -not $_.Match }).Count
  @("# $title", "# 与期望不一致：$mismatches 个", '') + ($rows | ForEach-Object { '{0}  期望 {1}  实际 {2}  {3}' -f ($_.Match ? '  ' : '✗ '), $_.Expect, $_.Actual, $_.Path })
}

try {
  foreach ($sample in $samples) {
    $file = Join-Path $tree $sample.Path
    New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
    Set-Content -LiteralPath $file -Value $sample.Path -NoNewline
  }
  $env:RESTIC_PASSWORD = 'probe-only'
  & $Restic init --repo $repo --quiet | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "restic init 退出码 $LASTEXITCODE" }

  $runs = Join-Path $PSScriptRoot 'runs'
  New-Item -ItemType Directory -Force -Path $runs | Out-Null
  $oldRows = Invoke-DryRun (Join-Path $PSScriptRoot 'input\restic-exclude-0.4.0.txt')
  $newRows = Invoke-DryRun (Resolve-Path -LiteralPath $NewBaseline).Path
  $version = (& $Restic version) -join ' '
  Format-Run "0.4.0 的基线（**/build*/**）  $version" $oldRows | Set-Content -LiteralPath (Join-Path $runs '01-baseline-0.4.0.txt') -Encoding utf8
  Format-Run "当前基线（$(Split-Path -Leaf $NewBaseline)）  $version" $newRows | Set-Content -LiteralPath (Join-Path $runs '02-baseline-current.txt') -Encoding utf8
  Get-Content -LiteralPath (Join-Path $runs '01-baseline-0.4.0.txt'), (Join-Path $runs '02-baseline-current.txt')
}
finally {
  Remove-Item -LiteralPath $work.FullName -Recurse -Force
}
