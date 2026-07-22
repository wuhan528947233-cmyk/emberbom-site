param(
    [string]$BaseUrl = "https://emberbom.com"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Net.Http

$baseUri = [Uri]$BaseUrl
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(20)
$client.DefaultRequestHeaders.UserAgent.ParseAdd("EmberBOM-T056-Acceptance/1.0")

function Send-Request {
    param(
        [System.Net.Http.HttpMethod]$Method,
        [string]$Path,
        [System.Net.Http.HttpContent]$Content = $null
    )

    $request = New-Object System.Net.Http.HttpRequestMessage($Method, [Uri]::new($baseUri, $Path))
    if ($null -ne $Content) {
        $request.Content = $Content
    }

    try {
        return $client.SendAsync($request).GetAwaiter().GetResult()
    } finally {
        $request.Dispose()
    }
}

function Read-Body {
    param([System.Net.Http.HttpResponseMessage]$Response)
    return $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
}

try {
    $criticalPages = @(
        "/",
        "/quick-start.html",
        "/privacy.html",
        "/terms.html",
        "/refund.html",
        "/license.txt",
        "/fulfillment.html",
        "/contact.html"
    )

    $homeResponse = $null
    foreach ($path in $criticalPages) {
        $response = Send-Request -Method ([System.Net.Http.HttpMethod]::Get) -Path $path
        try {
            if ([int]$response.StatusCode -ne 200) {
                throw "critical_page_failed: $path returned $([int]$response.StatusCode)"
            }
            if ($path -eq "/") {
                $homeResponse = $response
                $homeBody = Read-Body $response
                if ($homeBody -notmatch 'href="/download/windows"' -or
                    $homeBody -notmatch 'href="/download/linux"' -or
                    $homeBody -notmatch 'Live Paddle checkout is disabled') {
                    throw "production_homepage_closed_state_missing"
                }
            }
        } finally {
            if ($path -ne "/") {
                $response.Dispose()
            }
        }
    }

    foreach ($requiredHeader in @(
        "Content-Security-Policy",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "Permissions-Policy"
    )) {
        if (-not $homeResponse.Headers.Contains($requiredHeader) -and
            -not $homeResponse.Content.Headers.Contains($requiredHeader)) {
            throw "production_security_header_missing: $requiredHeader"
        }
    }
    $homeResponse.Dispose()

    $configResponse = Send-Request -Method ([System.Net.Http.HttpMethod]::Get) -Path "/api/paddle-config"
    try {
        $configBody = Read-Body $configResponse
        if ([int]$configResponse.StatusCode -ne 200) {
            throw "production_paddle_config_failed: $([int]$configResponse.StatusCode)"
        }
        $config = $configBody | ConvertFrom-Json
        if ($config.enabled -ne $false) {
            throw "production_paddle_checkout_not_disabled"
        }
        $forbiddenProperties = @(
            "environment",
            "clientSideToken",
            "productId",
            "priceId",
            "offerIdentifier",
            "webhookSecret",
            "database"
        )
        $propertyNames = @($config.PSObject.Properties.Name)
        foreach ($property in $forbiddenProperties) {
            if ($propertyNames -contains $property) {
                throw "production_paddle_config_leaked: $property"
            }
        }
        if ($configBody -match '(?:test|live)_[A-Za-z0-9]{10,}' -or
            $configBody -match '(?:pro|pri)_[a-z0-9]{10,}') {
            throw "production_paddle_identifier_leaked"
        }
    } finally {
        $configResponse.Dispose()
    }

    $webhookContent = New-Object System.Net.Http.StringContent("{}", [Text.Encoding]::UTF8, "application/json")
    $webhookResponse = Send-Request -Method ([System.Net.Http.HttpMethod]::Post) -Path "/api/paddle-webhook" -Content $webhookContent
    try {
        $webhookBody = Read-Body $webhookResponse
        if ([int]$webhookResponse.StatusCode -ne 404) {
            throw "production_webhook_not_closed: $([int]$webhookResponse.StatusCode)"
        }
        if ($webhookBody -match '(?:test|live)_[A-Za-z0-9]{10,}' -or
            $webhookBody -match '(?:pro|pri)_[a-z0-9]{10,}') {
            throw "production_webhook_response_leaked_identifier"
        }
    } finally {
        $webhookResponse.Dispose()
        $webhookContent.Dispose()
    }

    $downloadTargets = @{
        windows = "/downloads/emberbom_v0.1.0-rc.9_windows_amd64.zip"
        linux = "/downloads/emberbom_v0.1.0-rc.9_linux_amd64.tar.gz"
    }
    foreach ($platform in $downloadTargets.Keys) {
        $response = Send-Request -Method ([System.Net.Http.HttpMethod]::Head) -Path "/download/$platform"
        try {
            if ([int]$response.StatusCode -ne 302) {
                throw "download_head_redirect_failed: $platform returned $([int]$response.StatusCode)"
            }
            if ($null -eq $response.Headers.Location -or
                $response.Headers.Location.AbsolutePath -ne $downloadTargets[$platform]) {
                throw "download_redirect_target_mismatch: $platform"
            }
        } finally {
            $response.Dispose()
        }
    }

    "PRODUCTION_CRITICAL_PAGES=PASS"
    "PRODUCTION_SECURITY_HEADERS=PASS"
    "PRODUCTION_CHECKOUT_DISABLED=PASS"
    "PRODUCTION_CONFIG_DISCLOSURE=PASS"
    "PRODUCTION_WEBHOOK_CLOSED=PASS"
    "PRODUCTION_DOWNLOAD_ROUTES=PASS"
} finally {
    $client.Dispose()
    $handler.Dispose()
}
