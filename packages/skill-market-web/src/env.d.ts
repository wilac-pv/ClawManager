/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SKILL_MARKET_API_URL: string
  readonly VITE_SKILL_MARKET_ALLOW_INSECURE_HTTP?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
