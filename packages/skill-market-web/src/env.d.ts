/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SKILL_MARKET_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
