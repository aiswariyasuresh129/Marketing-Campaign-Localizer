#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination
)

$ErrorActionPreference = 'Stop'
[IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination, [IO.Compression.CompressionLevel]::Optimal, $false)
