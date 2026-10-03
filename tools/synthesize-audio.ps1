param([string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$items = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'en-US' } | Select-Object -First 1
    if (-not $voice) { throw 'An installed en-US voice is required.' }
    $synth.SelectVoice($voice.VoiceInfo.Name)
    $synth.Rate = -2
    $samples = @{}
    foreach ($item in $items) {
        $stream = New-Object System.IO.MemoryStream
        try {
            $synth.SetOutputToWaveStream($stream)
            $prompt = New-Object System.Speech.Synthesis.PromptBuilder ([System.Globalization.CultureInfo]::GetCultureInfo('en-US'))
            $prompt.AppendTextWithPronunciation($item.example, $item.phones)
            $synth.Speak($prompt)
            $synth.SetOutputToNull()
            $samples[$item.id] = [Convert]::ToBase64String($stream.ToArray())
        } finally { $stream.Dispose() }
    }
    $result = @{ voice = $voice.VoiceInfo.Name; samples = $samples }
    [System.IO.File]::WriteAllText($OutputPath, ($result | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding $false))
} finally { $synth.Dispose() }
