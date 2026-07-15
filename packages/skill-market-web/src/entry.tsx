import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { App } from "./app"
import "@opencode-ai/app/skill-market"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("Missing #root")

const client = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 30_000,
    },
  },
})

render(
  () => (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  ),
  root,
)
