"use client"

import { isProduction } from "@packages/env"
import { env } from "@packages/env/web-next"
import { QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider as NextThemesProvider } from "next-themes"
import { NuqsAdapter } from "nuqs/adapters/next/app"
import { useState } from "react"

import { DevTools } from "@/components/common/devtools"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { makeQueryClient } from "@/lib/query"
import { TOOLTIP_DELAY_MS } from "@/lib/tooltip"

export function OuterProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient)

  return (
    <QueryClientProvider client={queryClient}>
      <NuqsAdapter>{children}</NuqsAdapter>
      {!isProduction(env.NEXT_PUBLIC_NODE_ENV) && <DevTools />}
    </QueryClientProvider>
  )
}

export function InnerProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      <TooltipProvider delay={TOOLTIP_DELAY_MS} timeout={0}>
        {children}
      </TooltipProvider>
      <Toaster />
    </NextThemesProvider>
  )
}
