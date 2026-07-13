const downloads = {
  mac: {
    href: "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg",
    label: "下载 macOS 版",
    platform: "mac",
  },
  windows: {
    href: "http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe",
    label: "下载 Windows 版",
    platform: "windows",
  },
}

export function detectPlatform(userAgent) {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "mac"
  if (/Windows/i.test(userAgent)) return "windows"
  return "unknown"
}

export function recommendationFor(platform) {
  return downloads[platform] ?? { href: "#download", label: "选择下载版本", platform: null }
}

if (typeof document !== "undefined") {
  const recommendation = recommendationFor(detectPlatform(navigator.userAgent))
  const primary = document.querySelector("#primary-download")

  if (primary) {
    primary.href = recommendation.href
    primary.textContent = recommendation.label
  }

  if (recommendation.platform) {
    document.querySelector(`[data-platform="${recommendation.platform}"]`)?.classList.add("is-recommended")
  }
}
